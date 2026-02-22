import express from "express";
import cors from "cors";
import { ENV } from "./config/env";
import { tripsRouter } from "./routes/trips.routes";
import { publicRouter } from "./routes/public.routes";
import { requireApiSecret } from "./middleware/auth";
import { runMigrations } from "./db/migrate";
import { pool } from "./db/pool";

// Airtable settings helper
async function getAirtableSetting(key: string, defaultValue: string): Promise<string> {
  try {
    const url = `https://api.airtable.com/v0/${ENV.AIRTABLE_BASE_ID_CHAT}/Chat_Settings?filterByFormula={key}='${key}'&maxRecords=1`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${ENV.AIRTABLE_API_KEY}` },
    });
    const data = await resp.json();
    if (data.records && data.records.length > 0) {
      return data.records[0].fields.value || defaultValue;
    }
  } catch (e) {
    console.error(`[Settings] Failed to load ${key}:`, e);
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
      console.log(`[DraftCleanup] Deleted ${result.rowCount} expired drafts:`, 
        result.rows.map((r: any) => r.slug).join(', '));
    }
  } catch (error: any) {
    console.error("[DraftCleanup] Error:", error?.message);
  }
}

async function main() {
  // Run migrations first
  await runMigrations();

  const app = express();
  app.use(express.json());

  const allowedOrigins = ENV.CORS_ORIGINS.split(",").map(s => s.trim());
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS"));
    },
  }));

  // Health check (no auth)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "rng-trip-manager", version: "1.1.0" });
  });

  // Public routes (no auth — for landing page)
  app.use("/api/public/trip", publicRouter);

  // Protected routes (require x-api-secret from bitescout-web)
  app.use("/api/trips", requireApiSecret, tripsRouter);

  const PORT = ENV.PORT;
  app.listen(PORT, () => {
    console.log(`[rng-trip-manager] v1.1.0 listening on :${PORT}`);

    // Draft cleanup cron — every 60 minutes
    const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
    setInterval(cleanupDrafts, CLEANUP_INTERVAL_MS);
    console.log(`[rng-trip-manager] Draft cleanup interval: every ${CLEANUP_INTERVAL_MS / 60000} min`);

    // Run initial cleanup after 5 min
    setTimeout(cleanupDrafts, 5 * 60 * 1000);
  });
}

main().catch((err) => {
  console.error("[rng-trip-manager] Fatal:", err);
  process.exit(1);
});
