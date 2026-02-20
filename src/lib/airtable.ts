import { ENV } from "../config/env";

const HEADERS = {
  Authorization: `Bearer ${ENV.AIRTABLE_API_KEY}`,
  "Content-Type": "application/json",
};

async function getRecord(baseId: string, table: string, recordId: string): Promise<any> {
  const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}/${recordId}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
  return res.json();
}

async function findRecords(baseId: string, table: string, formula: string, maxRecords = 10): Promise<any[]> {
  const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=${maxRecords}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.records || [];
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
};
