import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required ENV: ${name}`);
  }
  return value;
}

export const ENV = {
  DATABASE_URL: requireEnv("DATABASE_URL"),
  OPENAI_API_KEY: requireEnv("OPENAI_API_KEY"),
  AIRTABLE_API_KEY: requireEnv("AIRTABLE_API_KEY"),
  AIRTABLE_BASE_ID_CHAT: requireEnv("AIRTABLE_BASE_ID_CHAT"),
  AIRTABLE_BASE_ID_OPS: requireEnv("AIRTABLE_BASE_ID_OPS"),
  API_SECRET: requireEnv("API_SECRET"),
  PORT: process.env.PORT || "3000",
  NODE_ENV: process.env.NODE_ENV || "development",
  CORS_ORIGINS: process.env.CORS_ORIGINS || "https://bitescout-web-zhea.onrender.com,https://bitescout.com,http://localhost:3000",
  RESEND_API_KEY: process.env.RESEND_API_KEY || "",
  RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET || "",
  NUDGE_ENABLED: process.env.NUDGE_ENABLED || "true",
  PEXELS_API_KEY: process.env.PEXELS_API_KEY || "",
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || "",
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || "",
  AWS_REGION: process.env.AWS_REGION || "us-east-1",
  S3_PHOTO_BANK_BUCKET: process.env.S3_PHOTO_BANK_BUCKET || "rng-photo-bank",
};
