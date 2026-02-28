import express from "express";
import cors from "cors";
import compression from "compression";
import { ENV } from "./config/env";
import { tripsRouter } from "./routes/trips.routes";
import { publicRouter } from "./routes/public.routes";
import { emailRouter } from "./routes/email.routes";
import { nudgeRouter } from "./routes/nudge.routes";
import { vendorRouter } from "./routes/vendor.routes";
import { webhookRouter } from "./routes/webhook.routes";
import { nudgeService } from "./services/nudge/nudge.service";
import { requireApiSecret } from "./middleware/auth";
import { runMigrations } from "./db/migrate";
import { pool } from "./db/pool";
import { log, correlationMiddleware } from "./lib/pino-logger";
import { asyncHandler } from "./lib/async-handler";
import { errorMiddleware, registerProcessHandlers } from "./lib/error-handler";
import { registerGracefulShutdown } from "./lib/graceful-shutdown";
import { deepHealthCheck } from "./lib/health";

// Interval refs for graceful shutdown
let draftCleanupInterval: ReturnType<typeof setInterval> | null = null;
let nudgeInterval: ReturnType<typeof setInterval> | null = null;

// Airtable settings helper
async function getAirtableSetting(key: string, defaultValue: string): Promise<string> {
  try {
    const url = `https://api.airtable.com/v0/${ENV.AIRTABLE_BASE_ID_CHAT}/Chat_Settings?filterByFormula={key}='${key}'&maxRecords=1`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${ENV.AIRTABLE_API_KEY}` },
    });
    const data: any = await resp.json();
    if (data.records && data.records.length > 0) {
      return data.records[0].fields.value || defaultValue;
    }
  } catch (e) {
    log.error({ err: e, key }, "settings.load_failed");
  }
  return defaultValue;
}

async function cleanupDrafts() {
  try {
    const ttlHours = parseInt(await getAirtableSetting("DRAFT_TTL_HOURS", "24"), 10);

    const result = await pool.query(
      `DELETE FROM trip_projects
       WHERE status = 'draft'
       AND payment_status != 'processing'
       AND created_at < NOW() - INTERVAL '1 hour' * $1
       RETURNING id, slug`,
      [ttlHours]
    );

    if (result.rowCount && result.rowCount > 0) {
      log.info(
        { count: result.rowCount, slugs: result.rows.map((r: any) => r.slug) },
        "cron.draft_cleanup.deleted"
      );
    }
  } catch (error: any) {
    log.error({ err: error }, "cron.draft_cleanup.error");
  }
}

async function main() {
  // Run migrations first
  await runMigrations();

  const app = express();

  // M1: Compression middleware
  app.use(compression());

  // Capture raw body for webhook signature verification — MUST be before express.json()
  app.use("/api/webhooks", express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf.toString("utf-8");
    }
  }));

  app.use(express.json());

  // M1: Correlation ID middleware
  app.use(correlationMiddleware);

  const allowedOrigins = ENV.CORS_ORIGINS.split(",").map(s => s.trim());
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS"));
    },
  }));

  // Health check — deep (checks PostgreSQL, Airtable)
  app.get("/health", asyncHandler(deepHealthCheck));

  // Public routes (no auth — for landing page)
  app.use("/api/public/trip", publicRouter);

  // Webhook routes (no auth — verified by signature)
  app.use("/api/webhooks", webhookRouter);

  // Protected routes (require x-api-secret from bitescout-web)
  app.use("/api/trips", requireApiSecret, tripsRouter);

  // Email routes (protected)
  app.use("/api/email", requireApiSecret, emailRouter);

  // Nudge routes (protected)
  app.use("/api/nudge", requireApiSecret, nudgeRouter);

  // Vendor inquiry routes (protected)
  app.use("/api/trips/vendor", requireApiSecret, vendorRouter);

  // M1: Error middleware — MUST be LAST
  app.use(errorMiddleware);

  const PORT = ENV.PORT;
  const server = app.listen(PORT, () => {
    log.info({ port: PORT }, "server.started");

    // Draft cleanup cron — every 60 minutes
    const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
    draftCleanupInterval = setInterval(cleanupDrafts, CLEANUP_INTERVAL_MS);
    log.info({ intervalMin: 60 }, "cron.draft_cleanup.scheduled");

    // Nudge Engine cron — every 60 minutes
    const NUDGE_INTERVAL_MS = 60 * 60 * 1000;
    nudgeInterval = setInterval(async () => {
      try {
        log.info("cron.nudge.start");
        const result = await nudgeService.runCycle();
        log.info({ processed: result.processed, errors: result.errors.length }, "cron.nudge.done");
      } catch (err: any) {
        log.error({ err }, "cron.nudge.error");
      }
    }, NUDGE_INTERVAL_MS);
    log.info({ intervalMin: 60 }, "cron.nudge.scheduled");

    // Run initial cleanup after 5 min
    setTimeout(cleanupDrafts, 5 * 60 * 1000);
  });

  // M1: Graceful shutdown
  registerGracefulShutdown({
    server,
    onShutdown: async () => {
      if (draftCleanupInterval) clearInterval(draftCleanupInterval);
      if (nudgeInterval) clearInterval(nudgeInterval);
      log.info("shutdown.intervals_cleared");
      await pool.end();
      log.info("shutdown.pg_pool_closed");
    },
  });

  // M1: Process-level error handlers
  registerProcessHandlers();
}

main().catch((err) => {
  log.fatal({ err }, "startup.fatal");
  process.exit(1);
});