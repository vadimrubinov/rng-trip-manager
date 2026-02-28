import { Request, Response } from "express";
import { pool } from "../db/pool";

interface HealthCheck {
  status: "ok" | "degraded" | "error";
  latency?: number;
  error?: string;
}

const startTime = Date.now();

async function checkPostgres(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    await pool.query("SELECT 1");
    return { status: "ok", latency: Date.now() - start };
  } catch (err: any) {
    return { status: "error", latency: Date.now() - start, error: err?.message };
  }
}

async function checkAirtable(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID_CHAT}/Chat_Settings?maxRecords=1`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return { status: "ok", latency: Date.now() - start };
  } catch (err: any) {
    return { status: "error", latency: Date.now() - start, error: err?.message };
  }
}

export async function deepHealthCheck(_req: Request, res: Response): Promise<void> {
  const [postgres, airtable] = await Promise.all([
    checkPostgres(),
    checkAirtable(),
  ]);

  const checks = { postgres, airtable };
  const allStatuses = Object.values(checks).map((c) => c.status);
  let status: "ok" | "degraded" | "down";

  if (allStatuses.every((s) => s === "ok")) status = "ok";
  else if (allStatuses.every((s) => s === "error")) status = "down";
  else status = "degraded";

  const httpStatus = status === "down" ? 503 : 200;
  res.status(httpStatus).json({
    status,
    service: "rng-trip-manager",
    version: "1.6.0",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    checks,
  });
}