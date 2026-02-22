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
};
