import { ENV } from "../config/env";
import { pool } from "../db/pool";
import { addCandidateFromBuffer, downloadImage, PhotoCategory, PhotoSource } from "./photo-bank.service";
import { log } from "../lib/pino-logger";
import { withRetry } from "../lib/retry";

// ── Types ──────────────────────────────────────────────

export interface CollectRequest {
  source: "md_raw" | "apify" | "og_image" | "all";
  region: string;
  limit?: number;
  offset?: string;
  dryRun?: boolean;
  concurrency?: number;
}

export interface CollectResult {
  source: string;
  region: string;
  records_scanned: number;
  images_found: number;
  ai_rejected: number;
  ai_passed: number;
  uploaded: number;
  duplicates_skipped: number;
  errors: number;
  next_offset: string | null;
  scores: { "1-3": number; "4-6": number; "7-10": number };
  categories: Record<string, number>;
  error_details: { url: string; error: string }[];
}

function emptyResult(source: string, region: string): CollectResult {
  return {
    source, region,
    records_scanned: 0, images_found: 0,
    ai_rejected: 0, ai_passed: 0, uploaded: 0,
    duplicates_skipped: 0, errors: 0,
    next_offset: null,
    scores: { "1-3": 0, "4-6": 0, "7-10": 0 },
    categories: {},
    error_details: [],
  };
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
  let u = url.trim().replace(/["']/g, "");
  // Strip alt text or title after space (markdown: ![](url "title") or ![](url alt))
  const spaceIdx = u.indexOf(" ");
  if (spaceIdx > 0) u = u.substring(0, spaceIdx);
  return u;
}

// ── Image URL extraction from markdown ─────────────────

function extractImageUrls(markdown: string): { url: string; alt: string }[] {
  const results: { url: string; alt: string }[] = [];
  const seen = new Set<string>();

  const mdRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = mdRegex.exec(markdown)) !== null) {
    const url = normalizeUrl(match[2]);
    if (!seen.has(url) && !isJunkUrl(url) && /^https?:\/\//i.test(url)) {
      seen.add(url);
      results.push({ url, alt: match[1] || "" });
    }
  }

  const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*(?:alt=["']([^"']*)["'])?/gi;
  while ((match = imgRegex.exec(markdown)) !== null) {
    const url = normalizeUrl(match[1]);
    if (!seen.has(url) && !isJunkUrl(url) && /^https?:\/\//i.test(url)) {
      seen.add(url);
      results.push({ url, alt: match[2] || "" });
    }
  }

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

// ── Airtable helpers ───────────────────────────────────

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

// ── AI Vision filter ───────────────────────────────────

const AI_VISION_PROMPT = `You are a photo curator for a trophy fishing trip booking platform.
Evaluate this image for use on a fishing trip landing page.

Score 1-10:
- 1-3: Not suitable (food/sushi, dead fish on counter, screenshots, infographics, blurry, interiors, stock placeholders, logos, people selfies, unrelated content)
- 4-6: Acceptable but not great (generic nature, low quality fishing photos, distant boats)
- 7-10: Great for landing page (epic landscapes, fishing action shots, beautiful water/sunset scenes, trophy fish catches, boats on water)

Category (pick one):
- hero: Epic wide landscape suitable for fullscreen cover (sunset, panoramic water, dramatic scenery)
- action: Fishing in progress (rod bending, fish jumping, fighting fish, casting)
- scenery: Beautiful nature/water/coast without fishing action
- fish: Clear photo of a fish species (caught or in water)
- band: Good for section divider (wide scenic shot, not hero-level epic)
- reject: Not suitable for fishing trip content

Description: Write a short description of the image content (10-15 words, English).

Respond ONLY in JSON: {"score": N, "category": "...", "description": "..."}`;

interface AiVisionResult {
  score: number;
  category: string;
  description: string;
}

async function aiFilterImage(buffer: Buffer, contentType: string): Promise<AiVisionResult | null> {
  try {
    const base64 = buffer.toString("base64");
    const mediaType = contentType.includes("png") ? "image/png"
      : contentType.includes("webp") ? "image/webp"
      : "image/jpeg";

    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey: ENV.OPENAI_API_KEY });

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: AI_VISION_PROMPT },
            {
              type: "image_url",
              image_url: {
                url: `data:${mediaType};base64,${base64}`,
                detail: "low",
              },
            },
          ],
        },
      ],
    });

    const text = resp.choices[0]?.message?.content?.trim() || "";
    const clean = text.replace(/```json\s*/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(clean);

    return {
      score: typeof parsed.score === "number" ? parsed.score : 0,
      category: parsed.category || "reject",
      description: parsed.description || "",
    };
  } catch (err: any) {
    log.warn({ err: err.message }, "photo_bank.ai_filter.error");
    return null;
  }
}

// ── Shared candidate processing ────────────────────────

interface RawCandidate {
  url: string;
  alt: string;
  vendor_record_id: string | null;
  region: string | null;
  country: string | null;
  source: PhotoSource;
}

const VALID_AI_CATEGORIES: PhotoCategory[] = ["hero", "action", "scenery", "fish", "band"];

async function processCandidates(
  candidates: RawCandidate[],
  result: CollectResult,
  maxUploads: number,
  concurrency: number,
  dryRun: boolean,
): Promise<void> {
  result.images_found = candidates.length;

  if (dryRun) return;

  let uploadedCount = 0;

  await runWithConcurrency(candidates, concurrency, async (c) => {
    if (uploadedCount >= maxUploads) return;

    try {
      // 1. Dedup
      const dup = await isDuplicate(c.url);
      if (dup) {
        result.duplicates_skipped++;
        return;
      }

      // 2. Download
      let buffer: Buffer;
      let contentType: string;
      try {
        const dl = await downloadImage(c.url);
        buffer = dl.buffer;
        contentType = dl.contentType;
      } catch (err: any) {
        result.errors++;
        result.error_details.push({ url: c.url, error: `download: ${err.message}` });
        return;
      }

      // 3. Size filter
      if (buffer.length < 50_000) {
        result.ai_rejected++;
        result.scores["1-3"]++;
        return;
      }

      // 4. AI vision filter
      const aiResult = await aiFilterImage(buffer, contentType);
      if (!aiResult) {
        result.errors++;
        result.error_details.push({ url: c.url, error: "ai_filter_failed" });
        return;
      }

      // Track scores
      if (aiResult.score <= 3) result.scores["1-3"]++;
      else if (aiResult.score <= 6) result.scores["4-6"]++;
      else result.scores["7-10"]++;

      // Track categories
      result.categories[aiResult.category] = (result.categories[aiResult.category] || 0) + 1;

      // 5. Reject
      if (aiResult.score < 4 || aiResult.category === "reject") {
        result.ai_rejected++;
        return;
      }

      result.ai_passed++;

      if (uploadedCount >= maxUploads) return;

      // 6. Category
      const species = detectFishSpecies(`${c.url} ${c.alt}`);
      const category: PhotoCategory = VALID_AI_CATEGORIES.includes(aiResult.category as PhotoCategory)
        ? aiResult.category as PhotoCategory
        : species ? "fish" : "scenery";

      // 7. Upload
      await addCandidateFromBuffer({
        source_url: c.url,
        region: c.region || undefined,
        country: c.country || undefined,
        category,
        species: species || undefined,
        source: c.source,
        vendor_record_id: c.vendor_record_id || undefined,
        ai_score: aiResult.score,
        ai_category: aiResult.category,
        ai_description: aiResult.description,
        buffer,
        contentType,
      });

      uploadedCount++;
      result.uploaded++;
    } catch (err: any) {
      result.errors++;
      result.error_details.push({ url: c.url, error: err.message });
    }
  });
}

// ══════════════════════════════════════════════════════════
// SOURCE 1: md_raw from SYS_Web_Scrapes
// ══════════════════════════════════════════════════════════

async function collectMdRaw(region: string, limit: number, offset: string | undefined, dryRun: boolean, concurrency: number): Promise<CollectResult> {
  const result = emptyResult("md_raw", region);

  const page = await fetchAirtablePage(
    ENV.AIRTABLE_BASE_ID_SYS,
    "SYS_Web_Scrapes",
    sysHeaders(),
    {
      fields: ["md_raw", "vendor_record_id", "Company", "Region"],
      pageSize: 100,
      offset: offset || undefined,
      filterByFormula: `AND({md_raw}!='', FIND("${region}", {Region}))`,
    },
  );

  result.records_scanned = page.records.length;
  result.next_offset = page.offset || null;

  const candidates: RawCandidate[] = [];
  for (const rec of page.records) {
    const f = rec.fields || {};
    const images = extractImageUrls(f.md_raw || "");
    for (const img of images) {
      candidates.push({
        url: img.url,
        alt: img.alt,
        vendor_record_id: f.vendor_record_id || null,
        region: f.Region || region,
        country: null,
        source: "md_raw",
      });
    }
  }

  await processCandidates(candidates, result, limit, concurrency, dryRun);
  return result;
}

// ══════════════════════════════════════════════════════════
// SOURCE 2: imageUrl from SYS_Leads_Vendors
// ══════════════════════════════════════════════════════════

async function collectApify(region: string, limit: number, offset: string | undefined, dryRun: boolean, concurrency: number): Promise<CollectResult> {
  const result = emptyResult("apify", region);

  const page = await fetchAirtablePage(
    ENV.AIRTABLE_BASE_ID_SYS,
    "SYS_Leads_Vendors",
    sysHeaders(),
    {
      fields: ["imageUrl", "Vendor_Record_ID", "city", "state_province", "countryCode"],
      pageSize: 100,
      offset: offset || undefined,
      filterByFormula: `AND({imageUrl}!='', FIND("${region}", {state_province}))`,
    },
  );

  result.records_scanned = page.records.length;
  result.next_offset = page.offset || null;

  const candidates: RawCandidate[] = [];
  for (const rec of page.records) {
    const f = rec.fields || {};
    const imageUrl = f.imageUrl;
    if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
      candidates.push({
        url: imageUrl,
        alt: "",
        vendor_record_id: f.Vendor_Record_ID || null,
        region: f.state_province || region,
        country: f.countryCode || null,
        source: "apify",
      });
    }
  }

  await processCandidates(candidates, result, limit, concurrency, dryRun);
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
    const match = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);

    if (!match?.[1]) return null;

    let ogUrl = match[1].trim();
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

async function collectOgImage(region: string, limit: number, offset: string | undefined, dryRun: boolean, concurrency: number): Promise<CollectResult> {
  const result = emptyResult("og_image", region);

  const page = await fetchAirtablePage(
    ENV.AIRTABLE_BASE_ID_OPS,
    "Vendors",
    opsHeaders(),
    {
      fields: ["Website_URL", "Region", "Country", "Name"],
      pageSize: 100,
      offset: offset || undefined,
      filterByFormula: `AND({Website_URL}!='', FIND("${region}", {Region}))`,
    },
  );

  result.records_scanned = page.records.length;
  result.next_offset = page.offset || null;

  const vendorPages: {
    recordId: string;
    websiteUrl: string;
    region: string | null;
    country: string | null;
  }[] = [];

  for (const rec of page.records) {
    const f = rec.fields || {};
    if (f.Website_URL) {
      vendorPages.push({
        recordId: rec.id,
        websiteUrl: f.Website_URL,
        region: f.Region || region,
        country: f.Country || null,
      });
    }
  }

  const candidates: RawCandidate[] = [];
  await runWithConcurrency(vendorPages, concurrency, async (v) => {
    const ogUrl = await fetchOgImage(v.websiteUrl);
    if (ogUrl) {
      candidates.push({
        url: ogUrl,
        alt: "",
        vendor_record_id: v.recordId,
        region: v.region,
        country: v.country,
        source: "og_image",
      });
    }
  });

  await processCandidates(candidates, result, limit, concurrency, dryRun);
  return result;
}

// ══════════════════════════════════════════════════════════
// Background job system
// ══════════════════════════════════════════════════════════

export interface CollectJob {
  id: string;
  status: "running" | "done" | "error" | "stopped";
  started_at: string;
  finished_at: string | null;
  request: CollectRequest;
  results: CollectResult[] | null;
  error: string | null;
  aborted?: boolean;
}

const jobs = new Map<string, CollectJob>();
let jobCounter = 0;

export function getCollectJob(jobId: string): CollectJob | null {
  return jobs.get(jobId) || null;
}

export function getCollectJobs(): CollectJob[] {
  return Array.from(jobs.values()).sort((a, b) => b.id.localeCompare(a.id));
}

export function stopCollectJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job || job.status !== "running") return false;
  job.aborted = true;
  job.status = "stopped";
  job.finished_at = new Date().toISOString();
  log.info({ jobId }, "photo_bank.collect.stopped");
  return true;
}

export function startCollect(req: CollectRequest): string {
  const jobId = `collect-${++jobCounter}-${Date.now()}`;
  const job: CollectJob = {
    id: jobId,
    status: "running",
    started_at: new Date().toISOString(),
    finished_at: null,
    request: req,
    results: null,
    error: null,
  };
  jobs.set(jobId, job);

  runCollect(job).catch((err) => {
    job.status = "error";
    job.error = err.message;
    job.finished_at = new Date().toISOString();
    log.error({ jobId, err }, "photo_bank.collect.job_error");
  });

  return jobId;
}

async function runCollect(job: CollectJob): Promise<void> {
  const req = job.request;
  const limit = req.limit || 200;
  const offset = req.offset || undefined;
  const dryRun = req.dryRun ?? false;
  const concurrency = req.concurrency || 5;

  log.info({ jobId: job.id, source: req.source, region: req.region, limit, dryRun, concurrency }, "photo_bank.collect.start");

  try {
    let results: CollectResult[];

    if (req.source === "all") {
      results = await Promise.all([
        collectMdRaw(req.region, limit, offset, dryRun, concurrency),
        collectApify(req.region, limit, offset, dryRun, concurrency),
        collectOgImage(req.region, limit, offset, dryRun, concurrency),
      ]);
    } else {
      let result: CollectResult;
      switch (req.source) {
        case "md_raw":
          result = await collectMdRaw(req.region, limit, offset, dryRun, concurrency);
          break;
        case "apify":
          result = await collectApify(req.region, limit, offset, dryRun, concurrency);
          break;
        case "og_image":
          result = await collectOgImage(req.region, limit, offset, dryRun, concurrency);
          break;
        default:
          throw new Error(`Unknown source: ${req.source}`);
      }
      results = [result];
    }

    job.results = results;
    job.status = "done";
    job.finished_at = new Date().toISOString();

    log.info({
      jobId: job.id,
      sources: results.map(r => ({
        source: r.source, uploaded: r.uploaded, ai_rejected: r.ai_rejected, errors: r.errors,
      })),
    }, "photo_bank.collect.done");
  } catch (err: any) {
    job.status = "error";
    job.error = err.message;
    job.finished_at = new Date().toISOString();
    throw err;
  }
}

/** Synchronous collect — for dryRun (fast, returns result directly) */
export async function collectPhotosSync(req: CollectRequest): Promise<CollectResult | CollectResult[]> {
  const limit = req.limit || 200;
  const offset = req.offset || undefined;
  const concurrency = req.concurrency || 5;

  if (req.source === "all") {
    return Promise.all([
      collectMdRaw(req.region, limit, offset, true, concurrency),
      collectApify(req.region, limit, offset, true, concurrency),
      collectOgImage(req.region, limit, offset, true, concurrency),
    ]);
  }

  switch (req.source) {
    case "md_raw": return collectMdRaw(req.region, limit, offset, true, concurrency);
    case "apify": return collectApify(req.region, limit, offset, true, concurrency);
    case "og_image": return collectOgImage(req.region, limit, offset, true, concurrency);
    default: throw new Error(`Unknown source: ${req.source}`);
  }
}
