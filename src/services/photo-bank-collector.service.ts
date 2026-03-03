import { ENV } from "../config/env";
import { pool } from "../db/pool";
import { addCandidate, PhotoCategory, PhotoSource } from "./photo-bank.service";
import { log } from "../lib/pino-logger";
import { withRetry } from "../lib/retry";

// ── Types ──────────────────────────────────────────────

export interface CollectRequest {
  source: "md_raw" | "apify" | "og_image" | "all";
  limit?: number;
  offset?: string;
  dryRun?: boolean;
  concurrency?: number;
}

export interface CollectResult {
  source: string;
  records_processed: number;
  candidates_found: number;
  duplicates_skipped: number;
  uploaded: number;
  errors: number;
  next_offset: string | null;
  error_details: { url: string; error: string }[];
}

// ── Fish species matching ──────────────────────────────

const FISH_SPECIES = [
  "salmon", "trout", "marlin", "tuna", "bass", "tarpon", "mahi", "sailfish", "swordfish",
  "halibut", "snapper", "grouper", "wahoo", "dorado", "pike", "walleye", "perch", "catfish",
  "cod", "carp", "barramundi", "bonefish", "permit", "roosterfish", "kingfish", "mackerel",
  "yellowtail", "amberjack", "cobia", "redfish", "steelhead", "musky", "sturgeon",
];

function detectFishSpecies(text: string): string | null {
  const lower = text.toLowerCase();
  for (const sp of FISH_SPECIES) {
    if (lower.includes(sp)) return sp;
  }
  return null;
}

// ── URL filtering ──────────────────────────────────────

const JUNK_PATTERNS = /icon|logo|favicon|sprite|pixel|tracking|badge|button|avatar|banner|widget/i;
const SMALL_SIZE_PATTERN = /\b(\d{1,3})x(\d{1,3})\b/;
const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp)(\?.*)?$/i;

function isJunkUrl(url: string): boolean {
  if (JUNK_PATTERNS.test(url)) return true;
  const sizeMatch = url.match(SMALL_SIZE_PATTERN);
  if (sizeMatch) {
    const w = parseInt(sizeMatch[1]);
    const h = parseInt(sizeMatch[2]);
    if (w < 200 && h < 200) return true;
  }
  if (/\.svg(\?|$)/i.test(url)) return true;
  if (/\.gif(\?|$)/i.test(url)) return true;
  if (url.startsWith("data:image/")) return true;
  return false;
}

function normalizeUrl(url: string): string {
  // Remove trailing whitespace, quotes
  return url.trim().replace(/["']/g, "");
}

// ── Image URL extraction from markdown ─────────────────

function extractImageUrls(markdown: string): { url: string; alt: string }[] {
  const results: { url: string; alt: string }[] = [];
  const seen = new Set<string>();

  // Pattern 1: ![alt](url)
  const mdRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = mdRegex.exec(markdown)) !== null) {
    const url = normalizeUrl(match[2]);
    if (!seen.has(url) && !isJunkUrl(url) && /^https?:\/\//i.test(url)) {
      seen.add(url);
      results.push({ url, alt: match[1] || "" });
    }
  }

  // Pattern 2: <img src="url">
  const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*(?:alt=["']([^"']*)["'])?/gi;
  while ((match = imgRegex.exec(markdown)) !== null) {
    const url = normalizeUrl(match[1]);
    if (!seen.has(url) && !isJunkUrl(url) && /^https?:\/\//i.test(url)) {
      seen.add(url);
      results.push({ url, alt: match[2] || "" });
    }
  }

  // Pattern 3: bare image URLs (lines that are just URLs ending with image ext)
  const lines = markdown.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (IMAGE_EXTENSIONS.test(trimmed) && /^https?:\/\//i.test(trimmed) && !seen.has(trimmed)) {
      if (!isJunkUrl(trimmed)) {
        seen.add(trimmed);
        results.push({ url: trimmed, alt: "" });
      }
    }
  }

  return results;
}

// ── Airtable SYS_DB helpers ────────────────────────────

function sysHeaders() {
  return {
    Authorization: `Bearer ${ENV.AIRTABLE_API_KEY_SYS}`,
    "Content-Type": "application/json",
  };
}

function opsHeaders() {
  return {
    Authorization: `Bearer ${ENV.AIRTABLE_API_KEY}`,
    "Content-Type": "application/json",
  };
}

interface AirtablePage {
  records: any[];
  offset?: string;
}

async function fetchAirtablePage(
  baseId: string,
  table: string,
  headers: Record<string, string>,
  params: {
    fields?: string[];
    pageSize?: number;
    offset?: string;
    filterByFormula?: string;
  },
): Promise<AirtablePage> {
  return withRetry(async () => {
    const qs = new URLSearchParams();
    if (params.pageSize) qs.set("pageSize", String(params.pageSize));
    if (params.offset) qs.set("offset", params.offset);
    if (params.filterByFormula) qs.set("filterByFormula", params.filterByFormula);
    if (params.fields) {
      for (const f of params.fields) qs.append("fields[]", f);
    }

    const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}?${qs.toString()}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
    return res.json() as Promise<AirtablePage>;
  }, { operationName: `airtable.page(${table})` });
}

// ── Duplicate check ────────────────────────────────────

async function isDuplicate(sourceUrl: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT id FROM photo_bank WHERE source_url = $1 LIMIT 1`,
    [sourceUrl],
  );
  return rows.length > 0;
}

// ── Concurrency pool ───────────────────────────────────

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i]);
    }
  });
  await Promise.allSettled(workers);
}

// ── Category detection ─────────────────────────────────

function detectCategory(url: string, alt: string): { category: PhotoCategory; species: string | null } {
  const combined = `${url} ${alt}`;
  const species = detectFishSpecies(combined);
  if (species) return { category: "fish", species };
  return { category: "scenery", species: null };
}

// ══════════════════════════════════════════════════════════
// SOURCE 1: md_raw from SYS_Web_Scrapes
// ══════════════════════════════════════════════════════════

async function collectMdRaw(limit: number, offset: string | undefined, dryRun: boolean, concurrency: number): Promise<CollectResult> {
  const result: CollectResult = {
    source: "md_raw",
    records_processed: 0,
    candidates_found: 0,
    duplicates_skipped: 0,
    uploaded: 0,
    errors: 0,
    next_offset: null,
    error_details: [],
  };

  const page = await fetchAirtablePage(
    ENV.AIRTABLE_BASE_ID_SYS,
    "SYS_Web_Scrapes",
    sysHeaders(),
    {
      fields: ["md_raw", "vendor_record_id", "Company", "Region"],
      pageSize: limit,
      offset: offset || undefined,
      filterByFormula: "AND({md_raw}!='')",
    },
  );

  result.records_processed = page.records.length;
  result.next_offset = page.offset || null;

  // Extract all image URLs from all records
  const candidates: {
    url: string;
    alt: string;
    vendor_record_id: string | null;
    region: string | null;
  }[] = [];

  for (const rec of page.records) {
    const f = rec.fields || {};
    const mdRaw = f.md_raw || "";
    const images = extractImageUrls(mdRaw);
    for (const img of images) {
      candidates.push({
        url: img.url,
        alt: img.alt,
        vendor_record_id: f.vendor_record_id || null,
        region: f.Region || null,
      });
    }
  }

  result.candidates_found = candidates.length;

  if (dryRun) return result;

  // Process candidates with concurrency
  await runWithConcurrency(candidates, concurrency, async (c) => {
    try {
      const dup = await isDuplicate(c.url);
      if (dup) {
        result.duplicates_skipped++;
        return;
      }
      const { category, species } = detectCategory(c.url, c.alt);
      await addCandidate({
        source_url: c.url,
        region: c.region || undefined,
        category,
        species: species || undefined,
        source: "md_raw",
        vendor_record_id: c.vendor_record_id || undefined,
      });
      result.uploaded++;
    } catch (err: any) {
      result.errors++;
      result.error_details.push({ url: c.url, error: err.message });
    }
  });

  return result;
}

// ══════════════════════════════════════════════════════════
// SOURCE 2: imageUrl from SYS_Leads_Vendors
// ══════════════════════════════════════════════════════════

async function collectApify(limit: number, offset: string | undefined, dryRun: boolean, concurrency: number): Promise<CollectResult> {
  const result: CollectResult = {
    source: "apify",
    records_processed: 0,
    candidates_found: 0,
    duplicates_skipped: 0,
    uploaded: 0,
    errors: 0,
    next_offset: null,
    error_details: [],
  };

  const page = await fetchAirtablePage(
    ENV.AIRTABLE_BASE_ID_SYS,
    "SYS_Leads_Vendors",
    sysHeaders(),
    {
      fields: ["imageUrl", "Vendor_Record_ID", "city", "state_province", "countryCode"],
      pageSize: limit,
      offset: offset || undefined,
      filterByFormula: "AND({imageUrl}!='')",
    },
  );

  result.records_processed = page.records.length;
  result.next_offset = page.offset || null;

  const candidates: {
    url: string;
    vendor_record_id: string | null;
    region: string | null;
    country: string | null;
  }[] = [];

  for (const rec of page.records) {
    const f = rec.fields || {};
    const imageUrl = f.imageUrl;
    if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
      candidates.push({
        url: imageUrl,
        vendor_record_id: f.Vendor_Record_ID || null,
        region: f.state_province || f.city || null,
        country: f.countryCode || null,
      });
    }
  }

  result.candidates_found = candidates.length;

  if (dryRun) return result;

  await runWithConcurrency(candidates, concurrency, async (c) => {
    try {
      const dup = await isDuplicate(c.url);
      if (dup) {
        result.duplicates_skipped++;
        return;
      }
      const { category, species } = detectCategory(c.url, "");
      await addCandidate({
        source_url: c.url,
        region: c.region || undefined,
        country: c.country || undefined,
        category,
        species: species || undefined,
        source: "apify",
        vendor_record_id: c.vendor_record_id || undefined,
      });
      result.uploaded++;
    } catch (err: any) {
      result.errors++;
      result.error_details.push({ url: c.url, error: err.message });
    }
  });

  return result;
}

// ══════════════════════════════════════════════════════════
// SOURCE 3: og:image from Vendors websites
// ══════════════════════════════════════════════════════════

async function fetchOgImage(websiteUrl: string): Promise<string | null> {
  try {
    const resp = await fetch(websiteUrl, {
      headers: { "User-Agent": "BiteScout-PhotoBank/1.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return null;

    const html = await resp.text();
    // Match <meta property="og:image" content="...">
    const match = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);

    if (!match?.[1]) return null;

    let ogUrl = match[1].trim();
    // Resolve relative URLs
    if (ogUrl.startsWith("/")) {
      const base = new URL(websiteUrl);
      ogUrl = `${base.protocol}//${base.host}${ogUrl}`;
    }

    if (!/^https?:\/\//i.test(ogUrl)) return null;
    if (isJunkUrl(ogUrl)) return null;

    return ogUrl;
  } catch {
    return null;
  }
}

async function collectOgImage(limit: number, offset: string | undefined, dryRun: boolean, concurrency: number): Promise<CollectResult> {
  const result: CollectResult = {
    source: "og_image",
    records_processed: 0,
    candidates_found: 0,
    duplicates_skipped: 0,
    uploaded: 0,
    errors: 0,
    next_offset: null,
    error_details: [],
  };

  const page = await fetchAirtablePage(
    ENV.AIRTABLE_BASE_ID_OPS,
    "Vendors",
    opsHeaders(),
    {
      fields: ["Website_URL", "Region", "Country", "Name"],
      pageSize: limit,
      offset: offset || undefined,
      filterByFormula: "AND({Website_URL}!='')",
    },
  );

  result.records_processed = page.records.length;
  result.next_offset = page.offset || null;

  // Phase 1: fetch og:image URLs (with concurrency)
  const vendorPages: {
    recordId: string;
    websiteUrl: string;
    region: string | null;
    country: string | null;
    name: string | null;
  }[] = [];

  for (const rec of page.records) {
    const f = rec.fields || {};
    if (f.Website_URL) {
      vendorPages.push({
        recordId: rec.id,
        websiteUrl: f.Website_URL,
        region: f.Region || null,
        country: f.Country || null,
        name: f.Name || null,
      });
    }
  }

  const candidates: {
    url: string;
    vendor_record_id: string;
    region: string | null;
    country: string | null;
  }[] = [];

  // Fetch og:image from each vendor website
  await runWithConcurrency(vendorPages, concurrency, async (v) => {
    const ogUrl = await fetchOgImage(v.websiteUrl);
    if (ogUrl) {
      candidates.push({
        url: ogUrl,
        vendor_record_id: v.recordId,
        region: v.region,
        country: v.country,
      });
    }
  });

  result.candidates_found = candidates.length;

  if (dryRun) return result;

  // Phase 2: download + upload candidates
  await runWithConcurrency(candidates, concurrency, async (c) => {
    try {
      const dup = await isDuplicate(c.url);
      if (dup) {
        result.duplicates_skipped++;
        return;
      }
      const { category, species } = detectCategory(c.url, "");
      await addCandidate({
        source_url: c.url,
        region: c.region || undefined,
        country: c.country || undefined,
        category,
        species: species || undefined,
        source: "og_image",
        vendor_record_id: c.vendor_record_id || undefined,
      });
      result.uploaded++;
    } catch (err: any) {
      result.errors++;
      result.error_details.push({ url: c.url, error: err.message });
    }
  });

  return result;
}

// ══════════════════════════════════════════════════════════
// Main collector entry point
// ══════════════════════════════════════════════════════════

export async function collectPhotos(req: CollectRequest): Promise<CollectResult | CollectResult[]> {
  const limit = req.limit || 50;
  const offset = req.offset || undefined;
  const dryRun = req.dryRun ?? false;
  const concurrency = req.concurrency || 5;

  log.info({ source: req.source, limit, dryRun, concurrency }, "photo_bank.collect.start");

  if (req.source === "all") {
    const results = await Promise.all([
      collectMdRaw(limit, offset, dryRun, concurrency),
      collectApify(limit, offset, dryRun, concurrency),
      collectOgImage(limit, offset, dryRun, concurrency),
    ]);
    log.info({
      sources: results.map(r => ({ source: r.source, uploaded: r.uploaded, errors: r.errors })),
    }, "photo_bank.collect.all.done");
    return results;
  }

  let result: CollectResult;
  switch (req.source) {
    case "md_raw":
      result = await collectMdRaw(limit, offset, dryRun, concurrency);
      break;
    case "apify":
      result = await collectApify(limit, offset, dryRun, concurrency);
      break;
    case "og_image":
      result = await collectOgImage(limit, offset, dryRun, concurrency);
      break;
    default:
      throw new Error(`Unknown source: ${req.source}`);
  }

  log.info({ source: result.source, uploaded: result.uploaded, errors: result.errors }, "photo_bank.collect.done");
  return result;
}
