import express from "express";
import cors from "cors";
import { ENV } from "./config/env";
import { tripsRouter } from "./routes/trips.routes";
import { publicRouter } from "./routes/public.routes";
import { requireApiSecret } from "./middleware/auth";
import { runMigrations } from "./db/migrate";

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
    res.json({ status: "ok", service: "rng-trip-manager", version: "1.0.0" });
  });

  // Public routes (no auth — for landing page)
  app.use("/api/public/trip", publicRouter);

  // Protected routes (require x-api-secret from bitescout-web)
  app.use("/api/trips", requireApiSecret, tripsRouter);

  const PORT = ENV.PORT;
  app.listen(PORT, () => {
    console.log(`[rng-trip-manager] v1.0.0 listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error("[rng-trip-manager] Fatal:", err);
  process.exit(1);
});
