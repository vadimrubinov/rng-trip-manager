import { log } from "../lib/pino-logger";
import { ENV } from "../config/env";
import { withRetry } from "./retry";

const HEADERS = {
  Authorization: `Bearer ${ENV.AIRTABLE_API_KEY}`,
  "Content-Type": "application/json",
};

async function getRecord(baseId: string, table: string, recordId: string): Promise<any> {
  return withRetry(
    async () => {
      const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}/${recordId}`;
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
      return res.json();
    },
    { operationName: `airtable.getRecord(${table})` }
  );
}

async function findRecords(baseId: string, table: string, formula: string, maxRecords = 10): Promise<any[]> {
  return withRetry(
    async () => {
      const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=${maxRecords}`;
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
      const data: any = await res.json();
      return data.records || [];
    },
    { operationName: `airtable.findRecords(${table})` }
  );
}

async function listRecords(baseId: string, table: string, maxRecords = 100): Promise<any[]> {
  return withRetry(
    async () => {
      const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}?maxRecords=${maxRecords}`;
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
      const data: any = await res.json();
      return data.records || [];
    },
    { operationName: `airtable.listRecords(${table})` }
  );
}

// --- AI Model Config ---

export type ModelConfig = {
  provider: string;
  model: string;
  temperature?: number;
};

const ROLE_FIELD_MAP: Record<string, string> = {
  trip_planner: "TripPlanner",
  nudge_ai: "NudgeAI",
  vendor_inquiry: "VendorInquiry",
  vendor_extract: "VendorExtract",
};

const ROLE_DEFAULTS: Record<string, ModelConfig> = {
  trip_planner: { provider: "openai", model: "gpt-4o", temperature: 0.3 },
  nudge_ai: { provider: "openai", model: "gpt-4o-mini", temperature: 0.7 },
  vendor_inquiry: { provider: "openai", model: "gpt-4o-mini", temperature: 0.3 },
  vendor_extract: { provider: "openai", model: "gpt-4o-mini", temperature: 0.2 },
};

const modelCache = new Map<string, { config: ModelConfig; cachedAt: number }>();
const MODEL_CACHE_TTL = 5 * 60 * 1000; // 5 min

export async function getModel(role: string): Promise<ModelConfig> {
  const cached = modelCache.get(role);
  if (cached && Date.now() - cached.cachedAt < MODEL_CACHE_TTL) {
    return cached.config;
  }

  const fieldName = ROLE_FIELD_MAP[role];
  const defaults = ROLE_DEFAULTS[role];
  if (!fieldName || !defaults) {
    log.warn({ role }, "[Airtable] Unknown model role, using defaults");
    return defaults || { provider: "openai", model: "gpt-4o", temperature: 0.3 };
  }

  try {
    const records = await findRecords(
      ENV.AIRTABLE_BASE_ID_CHAT,
      "AI_Models",
      `{${fieldName}}=TRUE()`,
      1
    );
    const f = records[0]?.fields;
    if (!f) {
      log.warn({ role }, "[Airtable] No active model found, using defaults");
      modelCache.set(role, { config: defaults, cachedAt: Date.now() });
      return defaults;
    }

    const config: ModelConfig = {
      provider: (f.Provider?.trim?.() || defaults.provider).toLowerCase(),
      model: f.Model?.trim?.() || defaults.model,
      temperature: typeof f.Temperature === "number" ? f.Temperature : defaults.temperature,
    };

    log.info({ role, provider: config.provider, model: config.model, temperature: config.temperature }, "[Airtable] Loaded model config");
    modelCache.set(role, { config, cachedAt: Date.now() });
    return config;
  } catch (e: any) {
    log.error({ err: e, role }, "[Airtable] Failed to load model, using defaults");
    return defaults;
  }
}

export async function getNudgeSettings(): Promise<Record<string, string>> {
  try {
    const records = await findRecords(
      ENV.AIRTABLE_BASE_ID_CHAT,
      "Chat_Settings",
      "FIND('NUDGE', {key})",
      20
    );
    const settings: Record<string, string> = {};
    for (const rec of records) {
      if (rec.fields?.key && rec.fields?.value !== undefined) {
        settings[rec.fields.key] = String(rec.fields.value);
      }
    }
    return settings;
  } catch (e: any) {
    log.error({ err: e }, "[Airtable] Failed to load Nudge settings");
    return {};
  }
}

export const airtable = {
  async getScout(recordId: string): Promise<{ brief: string; transcript: string; title: string } | null> {
    try {
      const rec = await getRecord(ENV.AIRTABLE_BASE_ID_CHAT, "Scouts", recordId);
      return {
        brief: rec.fields?.Brief || "",
        transcript: rec.fields?.Transcript || "",
        title: rec.fields?.Title || "",
      };
    } catch {
      return null;
    }
  },

  async getPrompt(key: string): Promise<string | null> {
    try {
      const records = await findRecords(
        ENV.AIRTABLE_BASE_ID_CHAT,
        "Prompts",
        `AND({Key}='${key}',{Is_Active}=TRUE())`,
        1
      );
      return records[0]?.fields?.Prompt_Text || null;
    } catch {
      return null;
    }
  },

  async getEmailSettings(): Promise<Record<string, string>> {
    try {
      const records = await listRecords(ENV.AIRTABLE_BASE_ID_CHAT, "Email_Settings", 20);
      const settings: Record<string, string> = {};
      for (const rec of records) {
        if (rec.fields?.key && rec.fields?.value) {
          settings[rec.fields.key] = rec.fields.value;
        }
      }
      return settings;
    } catch (e: any) {
      log.error({ err: e }, "[Airtable] Failed to load Email_Settings");
      return {};
    }
  },

  async getEmailTemplate(key: string): Promise<{ subject: string; bodyHtml: string } | null> {
    try {
      const records = await findRecords(
        ENV.AIRTABLE_BASE_ID_CHAT,
        "Email_Templates",
        `AND({Key}='${key}',{Is_Active}=TRUE())`,
        1
      );
      const fields = records[0]?.fields;
      if (!fields) return null;
      return {
        subject: fields.Subject || "",
        bodyHtml: fields.Body_HTML || "",
      };
    } catch (e: any) {
      log.error({ err: e }, "[Airtable] Failed to load Email_Template");
      return null;
    }
  },

  async getVendorById(recordId: string): Promise<{
    name: string;
    email: string | null;
    phone: string | null;
    website: string | null;
    region: string | null;
    country: string | null;
    rating: number | null;
    reviews: number | null;
  } | null> {
    try {
      const rec = await getRecord(ENV.AIRTABLE_BASE_ID_OPS, "Vendors", recordId);
      const f = rec.fields || {};
      return {
        name: f.Name || "",
        email: f.Contact_Email || null,
        phone: f.Contact_Phone || null,
        website: f.Website_URL || null,
        region: f.Region || null,
        country: f.Country || null,
        rating: f.Google_Rating ?? null,
        reviews: f.Reviews_Count ?? null,
      };
    } catch (e: any) {
      log.error({ err: e }, "[Airtable] Failed to get vendor");
      return null;
    }
  },

  async getChatSetting(key: string): Promise<string | null> {
    try {
      const records = await findRecords(
        ENV.AIRTABLE_BASE_ID_CHAT,
        "Chat_Settings",
        `{key}='${key}'`,
        1
      );
      return records[0]?.fields?.value ?? null;
    } catch (e: any) {
      log.error({ err: e }, "[Airtable] Failed to get Chat_Setting");
      return null;
    }
  },
};
