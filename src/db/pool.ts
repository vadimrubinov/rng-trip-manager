import { Pool, QueryResult } from "pg";
import { ENV } from "../config/env";

export const pool = new Pool({
  connectionString: ENV.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("[DB] Pool error:", err.message);
});

export async function query<T = any>(sql: string, params?: any[]): Promise<T[]> {
  const result: QueryResult<T> = await pool.query(sql, params);
  return result.rows;
}

export async function queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] || null;
}

export async function execute(sql: string, params?: any[]): Promise<number> {
  const result = await pool.query(sql, params);
  return result.rowCount || 0;
}
