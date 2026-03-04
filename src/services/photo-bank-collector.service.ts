import { ENV } from "../config/env";
import { pool } from "../db/pool";
import { addCandidateFromBuffer, downloadImage, PhotoCategory, PhotoSource } from "./photo-bank.service";
import { log } from "../lib/pino-logger";
import { withRetry } from "../lib/retry";
// ── Image dimension reading (pure JS, no native deps) ──

function readImageDimensions(buffer: Buffer): { width: number; height: number } {
  // JPEG: look for SOF0/SOF2 markers
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
    let offset = 2;
    while (offset < buffer.length - 8) {
      if (buffer[offset] !== 0xFF) break;
      const marker = buffer[offset + 1];
      // SOF0 or SOF2 (baseline/progressive JPEG)
      if (marker === 0xC0 || marker === 0xC2) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        return { width, height };
      }
      const segLen = buffer.readUInt16BE(offset + 2);
      offset += 2 + segLen;
    }
  }
  // PNG: IHDR at bytes 16-23
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return { width, height };
  }
  // WebP: RIFF header, width/height at 26-29
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
    if (buffer.length > 29 && buffer[12] === 0x56 && buffer[13] === 0x50 && buffer[14] === 0x38) {
      // VP8
      if (buffer[15] === 0x20) {
        const width = buffer.readUInt16LE(26) & 0x3FFF;
        const height = buffer.readUInt16LE(28) & 0x3FFF;
        return { width, height };
      }
      // VP8L
      if (buffer[15] === 0x4C && buffer.length > 25) {
        const bits = buffer.readUInt32LE(21);
        const width = (bits & 0x3FFF) + 1;
        const height = ((bits >> 14) & 0x3FFF) + 1;
        return { width, height };
      }
    }
  }
  return { width: 800, height: 600 }; // fallback
}



// ── Types ──────────────────────────────────────────────

export interface CollectRequest {
  source: "md_raw" | "apify" | "og_image" | "all";
  region: string;
  target?: number;
  dryRun?: boolean;
  concurrency?: number;
}

export interface CategoryProgress {
  collected: number;
  target: number;
  done: boolean;
}

export interface CollectResult {
  source: string;
  region: string;
  vendors_scanned: number;
  images_found: number;
  ai_rejected: number;
  ai_passed: number;
  uploaded: number;
  duplicates_skipped: number;
  too_small: number;
  errors: number;
  progress: Record<string, CategoryProgress>;
  stopped_reason: "all_targets_met" | "sources_exhausted" | null;
  scores: { "1-3": number; "4-6": number; "7-10": number };
  error_details: { url: string; error: string }[];
}

// ── Category Tracker ──────────────────────────────────

const DEFAULT_TARGETS: Record<string, number> = {
  hero: 5,
  action: 5,
  scenery: 20,
  band: 5,
  fish: 5,
};

export class CategoryTracker {
  private targets: Record<string, number>;
  private collected: Record<string, number> = {};

  constructor(baseTarget: number = 5) {
    this.targets = {
      hero: baseTarget,
      action: baseTarget,
      scenery: baseTarget * 4,
      band: baseTarget,
      fish: baseTarget,
    };
    for (const cat of Object.keys(this.targets)) {
      this.collected[cat] = 0;
    }
  }

  /** Check if a category still needs photos */
  needsMore(category: string): boolean {
    const target = this.targets[category];
    if (target === undefined) return false;
    return this.collected[category] < target;
  }

  /** Record a collected photo */
  record(category: string): void {
    if (this.collected[category] !== undefined) {
      this.collected[category]++;
    }
  }

  /** Check if all categories met their targets */
  allDone(): boolean {
    for (const cat of Object.keys(this.targets)) {
      if (this.collected[cat] < this.targets[cat]) return false;
    }
    return true;
  }

  /** Get progress snapshot */
  getProgress(): Record<string, CategoryProgress> {
    const result: Record<string, CategoryProgress> = {};
    for (const cat of Object.keys(this.targets)) {
      result[cat] = {
        collected: this.collected[cat],
        target: this.targets[cat],
        done: this.collected[cat] >= this.targets[cat],
      };
    }
    return result;
  }
}

function emptyResult(source: string, region: string): CollectResult {
  return {
    source, region,
    vendors_scanned: 0, images_found: 0,
    ai_rejected: 0, ai_passed: 0, uploaded: 0,
    duplicates_skipped: 0, too_small: 0, errors: 0,
    progress: {},
    stopped_reason: null,
    scores: { "1-3": 0, "4-6": 0, "7-10": 0 },
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
    sort?: { field: string; direction: "asc" | "desc" }[];
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
    if (params.sort) {
      for (let i = 0; i < params.sort.length; i++) {
        qs.append(`sort[${i}][field]`, params.sort[i].field);
        qs.append(`sort[${i}][direction]`, params.sort[i].direction);
      }
    }

    const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}?${qs.toString()}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
    return res.json() as Promise<AirtablePage>;
  }, { operationName: `airtable.page(${table})` });
}

/** Fetch ALL pages from Airtable (handles pagination) */
async function fetchAllAirtablePages(
  baseId: string,
  table: string,
  headers: Record<string, string>,
  params: {
    fields?: string[];
    pageSize?: number;
    filterByFormula?: string;
    sort?: { field: string; direction: "asc" | "desc" }[];
  },
): Promise<any[]> {
  const allRecords: any[] = [];
  let offset: string | undefined;
  do {
    const page = await fetchAirtablePage(baseId, table, headers, { ...params, offset });
    allRecords.push(...page.records);
    offset = page.offset;
  } while (offset);
  return allRecords;
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

const AI_VISION_PROMPT = `You are a strict photo curator for a premium trophy fishing trip booking platform.
Evaluate this image for use on a fishing trip landing page. Be CRITICAL — only truly good photos score 7+.

SCORING RULES (1-10):
- 1-3: Reject — food/sushi, dead fish on counter, screenshots, infographics, blurry/out-of-focus, dark interiors, logos, stock placeholders, unrelated content
- 4-6: Below average — generic nature with no fishing context, very distant subjects, technically poor photos, underwater shots with murky/unclear water
- 7-8: Good — clear fishing subject, decent composition, adequate lighting
- 9-10: Excellent — professional quality, dramatic lighting, compelling composition, emotionally engaging

AUTOMATIC SCORE PENALTIES (apply before final score):
- Subject occupies less than 20% of the frame (mostly sky, water, or empty space): -3
- Underwater shot with murky, greenish, or unclear water: -3
- Selfie angle (camera pointing down at person holding fish): -2
- Overexposed sky (blown-out white sky >40% of frame): -2
- Backlit subject (subject in shadow, bright background): -2
- Multiple heavy penalties can reduce score below 1 → assign score 2, category reject

CATEGORY RULES (pick one):
- hero: Wide horizontal landscape with dramatic fishing moment — angler fighting fish, rod bent, big splash, epic scenery. MUST be landscape orientation. NEVER assign to vertical photos. Subject must be clearly visible.
- action: Active fishing scene — rod bending, fish jumping, casting, netting. Can be horizontal or vertical BUT subject must fill at least 30% of frame.
- scenery: Beautiful nature/water/coastline without active fishing. Must have good lighting and composition.
- fish: Photo focused on a fish — caught fish being held, fish in water, close-up of species. Use for BOTH vertical AND horizontal fish photos. Also use for angler selfies holding a catch (even if low score).
- band: Wide horizontal shot suitable for section divider — boat, equipment, dock, preparation scene.
- reject: Blurry, dark, unrelated, food, interiors, logos, or any photo not suitable for a fishing trip landing page.

CATEGORY PRIORITY RULES:
- Person holding fish (any angle, including selfie) → fish category (not action)
- Vertical photo of fish or angler with fish → fish category (not action)
- Underwater photo with clear subject and clean water → action or fish
- Underwater photo with murky/unclear water → reject or score ≤4
- Mostly sky or water with tiny distant subject → scenery (score ≤5) or reject

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

// ── Target aspect ratios per category ──────────────────

interface CategorySpec {
  w: number;       // ratio width
  h: number;       // ratio height
  landscape: boolean;
  minW: number;    // minimum output width px (also final output width)
  minH: number;    // minimum output height px (also final output height)
}

const CATEGORY_RATIOS: Record<string, CategorySpec> = {
  hero:    { w: 16, h: 9,  landscape: true,  minW: 1200, minH: 675  },
  band:    { w: 21, h: 9,  landscape: true,  minW: 1200, minH: 514  },
  action:  { w: 4,  h: 3,  landscape: true,  minW: 600,  minH: 450  },
  scenery: { w: 3,  h: 2,  landscape: true,  minW: 900,  minH: 600  },
  fish:    { w: 3,  h: 4,  landscape: false, minW: 600,  minH: 800  },
};

/** Check if image is landscape orientation */
function isLandscape(width: number, height: number): boolean {
  return width > height;
}

/** Reassign category if orientation doesn't match requirement */
function fixCategoryByOrientation(category: PhotoCategory, width: number, height: number): PhotoCategory {
  const spec = CATEGORY_RATIOS[category];
  if (!spec) return category;

  const landscape = isLandscape(width, height);

  if (spec.landscape && !landscape) {
    // Vertical photo can't be hero/band/action/scenery
    if (category === "hero" || category === "band") return "action";
    if (category === "scenery") return "action";
    // action stays action even if vertical (will be cropped)
    return category;
  }

  if (!spec.landscape && landscape) {
    // Horizontal photo assigned to fish — keep it, crop will handle
    return category;
  }

  return category;
}

/** Center-crop + resize to exact category spec using sharp.
 *
 * Rules:
 *  1. Source too small (after crop would be < minW or minH) → throws Error("too_small")
 *  2. Crop to target ratio (center) → resize down to minW × minH → JPEG q85
 */
async function smartCrop(
  buffer: Buffer,
  category: string,
  srcW: number,
  srcH: number,
): Promise<{ buffer: Buffer; width: number; height: number; contentType: string }> {
  const spec = CATEGORY_RATIOS[category] || CATEGORY_RATIOS.scenery;
  const targetRatio = spec.w / spec.h;
  const srcRatio = srcW / srcH;

  // ── Step 1: calculate crop region (center crop to target ratio) ──
  let cropW = srcW;
  let cropH = srcH;

  if (srcRatio > targetRatio) {
    // Source is wider than target — crop sides
    cropW = Math.round(srcH * targetRatio);
  } else if (srcRatio < targetRatio) {
    // Source is taller than target — crop top/bottom
    cropH = Math.round(srcW / targetRatio);
  }

  const left = Math.round((srcW - cropW) / 2);
  const top  = Math.round((srcH - cropH) / 2);

  // ── Step 2: reject if cropped region is smaller than minimum ──
  if (cropW < spec.minW || cropH < spec.minH) {
    throw new Error("too_small");
  }

  // ── Step 3: crop + resize to exact output size ──
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sharpLib = require("sharp") as typeof import("sharp");
  const out = await sharpLib(buffer)
    .extract({ left, top, width: cropW, height: cropH })
    .resize(spec.minW, spec.minH, { fit: "fill" })
    .jpeg({ quality: 85, progressive: true })
    .toBuffer();

  return { buffer: out, width: spec.minW, height: spec.minH, contentType: "image/jpeg" };
}


async function processCandidates(
  candidates: RawCandidate[],
  result: CollectResult,
  tracker: CategoryTracker,
  concurrency: number,
  dryRun: boolean,
  abortCheck: () => boolean,
): Promise<void> {
  result.images_found += candidates.length;

  if (dryRun) return;

  await runWithConcurrency(candidates, concurrency, async (c) => {
    if (tracker.allDone() || abortCheck()) return;

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

      // 3. Size filter (bytes)
      if (buffer.length < 50_000) {
        result.ai_rejected++;
        result.scores["1-3"]++;
        return;
      }

      // 3b. Pixel dimensions pre-filter (before AI — free)
      // Reject if smaller than the softest category minimum (action: 800×600)
      // min dimension = 600px — anything smaller can't fit any category after crop
      const preDims = readImageDimensions(buffer);
      const minCategoryDim = Math.min(
        ...Object.values(CATEGORY_RATIOS).map(s => Math.min(s.minW, s.minH))
      );
      if (preDims.width < minCategoryDim || preDims.height < minCategoryDim) {
        result.ai_rejected++;
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

      // 5. Reject low scores or reject category
      if (aiResult.score < 7 || aiResult.category === "reject") {
        result.ai_rejected++;
        return;
      }

      // 6. Determine category
      const species = detectFishSpecies(`${c.url} ${c.alt}`);
      const category: PhotoCategory = VALID_AI_CATEGORIES.includes(aiResult.category as PhotoCategory)
        ? aiResult.category as PhotoCategory
        : species ? "fish" : "scenery";

      // 7. Smart stop — skip if category is full
      if (!tracker.needsMore(category)) {
        return;
      }

      // 8. Get dimensions + fix orientation
      const { width: imgW, height: imgH } = readImageDimensions(buffer);

      const finalCategory = fixCategoryByOrientation(category, imgW, imgH);

      // Re-check target after category reassignment
      if (!tracker.needsMore(finalCategory)) {
        return;
      }

      result.ai_passed++;

      // 9. Smart crop to target aspect ratio
      let finalBuffer = buffer;
      let finalContentType = contentType;
      let finalWidth = imgW;
      let finalHeight = imgH;
      try {
        const cropped = await smartCrop(buffer, finalCategory, imgW, imgH);
        finalBuffer = cropped.buffer;
        finalContentType = cropped.contentType;
        finalWidth = cropped.width;
        finalHeight = cropped.height;
      } catch (err: any) {
        if (err.message === "too_small") {
          log.debug({ url: c.url, category: finalCategory, w: imgW, h: imgH }, "photo_bank.crop.too_small");
          result.too_small++;
          return;
        }
        // Other crop errors — upload original as fallback
        log.warn({ err: err.message, url: c.url }, "photo_bank.crop.error");
      }

      // 10. Upload
      await addCandidateFromBuffer({
        source_url: c.url,
        region: c.region || undefined,
        country: c.country || undefined,
        category: finalCategory,
        species: species || undefined,
        source: c.source,
        vendor_record_id: c.vendor_record_id || undefined,
        ai_score: aiResult.score,
        ai_category: aiResult.category,
        ai_description: aiResult.description,
        buffer: finalBuffer,
        contentType: finalContentType,
        width: finalWidth,
        height: finalHeight,
      });

      tracker.record(finalCategory);
      result.uploaded++;
    } catch (err: any) {
      result.errors++;
      result.error_details.push({ url: c.url, error: err.message });
    }
  });
}

// ── Vendor sorting by Data_Score ──────────────────────

interface VendorRef {
  recordId: string;
  dataScore: number;
  region: string | null;
  country: string | null;
  websiteUrl: string | null;
}

async function fetchVendorsSortedByScore(region: string): Promise<VendorRef[]> {
  const records = await fetchAllAirtablePages(
    ENV.AIRTABLE_BASE_ID_OPS,
    "Vendors",
    opsHeaders(),
    {
      fields: ["Name", "Data_Score", "Region", "Country", "Website_URL"],
      filterByFormula: `FIND("${region}", {Region})`,
      sort: [{ field: "Data_Score", direction: "desc" }],
    },
  );

  return records.map((rec: any) => ({
    recordId: rec.id,
    dataScore: rec.fields?.Data_Score || 0,
    region: rec.fields?.Region || region,
    country: rec.fields?.Country || null,
    websiteUrl: rec.fields?.Website_URL || null,
  }));
}

// ══════════════════════════════════════════════════════════
// SOURCE 1: md_raw from SYS_Web_Scrapes (sorted by vendor Data_Score)
// ══════════════════════════════════════════════════════════

async function collectMdRaw(
  region: string, vendors: VendorRef[], tracker: CategoryTracker,
  result: CollectResult, concurrency: number, dryRun: boolean, abortCheck: () => boolean,
): Promise<void> {
  for (const vendor of vendors) {
    if (tracker.allDone() || abortCheck()) break;

    // Fetch scrapes for this vendor
    let scrapes: any[];
    try {
      scrapes = await fetchAllAirtablePages(
        ENV.AIRTABLE_BASE_ID_SYS,
        "SYS_Web_Scrapes",
        sysHeaders(),
        {
          fields: ["md_raw", "vendor_record_id", "Company", "Region"],
          filterByFormula: `AND({md_raw}!='', {vendor_record_id}='${vendor.recordId}')`,
        },
      );
    } catch {
      continue;
    }

    if (scrapes.length === 0) continue;
    result.vendors_scanned++;

    const candidates: RawCandidate[] = [];
    for (const rec of scrapes) {
      const f = rec.fields || {};
      const images = extractImageUrls(f.md_raw || "");
      for (const img of images) {
        candidates.push({
          url: img.url,
          alt: img.alt,
          vendor_record_id: vendor.recordId,
          region: vendor.region,
          country: vendor.country,
          source: "md_raw",
        });
      }
    }

    if (candidates.length > 0) {
      await processCandidates(candidates, result, tracker, concurrency, dryRun, abortCheck);
    }
  }
}

// ══════════════════════════════════════════════════════════
// SOURCE 2: og:image from Vendors websites (already sorted)
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

async function collectOgImage(
  region: string, vendors: VendorRef[], tracker: CategoryTracker,
  result: CollectResult, concurrency: number, dryRun: boolean, abortCheck: () => boolean,
): Promise<void> {
  const vendorsWithSites = vendors.filter(v => v.websiteUrl);

  // Fetch OG images in parallel batches
  const batchSize = 5;
  for (let i = 0; i < vendorsWithSites.length; i += batchSize) {
    if (tracker.allDone() || abortCheck()) break;

    const batch = vendorsWithSites.slice(i, i + batchSize);
    result.vendors_scanned += batch.length;

    const candidates: RawCandidate[] = [];
    await runWithConcurrency(batch, concurrency, async (v) => {
      const ogUrl = await fetchOgImage(v.websiteUrl!);
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

    if (candidates.length > 0) {
      await processCandidates(candidates, result, tracker, concurrency, dryRun, abortCheck);
    }
  }
}

// ══════════════════════════════════════════════════════════
// SOURCE 3: imageUrl from SYS_Leads_Vendors (sorted by vendor Data_Score)
// ══════════════════════════════════════════════════════════

async function collectApify(
  region: string, vendors: VendorRef[], tracker: CategoryTracker,
  result: CollectResult, concurrency: number, dryRun: boolean, abortCheck: () => boolean,
): Promise<void> {
  for (const vendor of vendors) {
    if (tracker.allDone() || abortCheck()) break;

    let leads: any[];
    try {
      leads = await fetchAllAirtablePages(
        ENV.AIRTABLE_BASE_ID_SYS,
        "SYS_Leads_Vendors",
        sysHeaders(),
        {
          fields: ["imageUrl", "Vendor_Record_ID", "city", "state_province", "countryCode"],
          filterByFormula: `AND({imageUrl}!='', {Vendor_Record_ID}='${vendor.recordId}')`,
        },
      );
    } catch {
      continue;
    }

    if (leads.length === 0) continue;
    result.vendors_scanned++;

    const candidates: RawCandidate[] = [];
    for (const rec of leads) {
      const f = rec.fields || {};
      const imageUrl = f.imageUrl;
      if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
        candidates.push({
          url: imageUrl,
          alt: "",
          vendor_record_id: vendor.recordId,
          region: vendor.region,
          country: vendor.country,
          source: "apify",
        });
      }
    }

    if (candidates.length > 0) {
      await processCandidates(candidates, result, tracker, concurrency, dryRun, abortCheck);
    }
  }
}

// ══════════════════════════════════════════════════════════
// Available regions endpoint
// ══════════════════════════════════════════════════════════

interface AvailableRegion {
  region: string;
  country: string;
  vendors_count: number;
}

let cachedRegions: AvailableRegion[] | null = null;
let regionsCacheTime = 0;
const REGIONS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

export async function getAvailableRegions(): Promise<AvailableRegion[]> {
  if (cachedRegions && Date.now() - regionsCacheTime < REGIONS_CACHE_TTL) {
    return cachedRegions;
  }

  const records = await fetchAllAirtablePages(
    ENV.AIRTABLE_BASE_ID_OPS,
    "Vendors",
    opsHeaders(),
    {
      fields: ["Region", "Country"],
    },
  );

  const map = new Map<string, { country: string; count: number }>();
  for (const rec of records) {
    const region = rec.fields?.Region;
    const country = rec.fields?.Country;
    if (!region) continue;
    const existing = map.get(region);
    if (existing) {
      existing.count++;
    } else {
      map.set(region, { country: country || "", count: 1 });
    }
  }

  const result: AvailableRegion[] = [];
  for (const [region, { country, count }] of map) {
    result.push({ region, country, vendors_count: count });
  }
  result.sort((a, b) => b.vendors_count - a.vendors_count);

  cachedRegions = result;
  regionsCacheTime = Date.now();
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
  result: CollectResult | null;
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
    result: null,
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
  const target = req.target || 5;
  const dryRun = req.dryRun ?? false;
  const concurrency = req.concurrency || 2;
  const tracker = new CategoryTracker(target);
  const abortCheck = () => !!job.aborted;

  log.info({ jobId: job.id, source: req.source, region: req.region, target, dryRun, concurrency }, "photo_bank.collect.start");

  const result = emptyResult(req.source, req.region);
  job.result = result;

  try {
    // Fetch vendors sorted by Data_Score DESC
    const vendors = await fetchVendorsSortedByScore(req.region);
    log.info({ jobId: job.id, vendorsFound: vendors.length }, "photo_bank.collect.vendors_loaded");

    // Sources run sequentially, sharing one tracker
    const sources: ("md_raw" | "og_image" | "apify")[] =
      req.source === "all" ? ["md_raw", "og_image", "apify"] : [req.source];

    for (const source of sources) {
      if (tracker.allDone() || abortCheck()) break;

      result.source = req.source === "all" ? "all" : source;

      switch (source) {
        case "md_raw":
          await collectMdRaw(req.region, vendors, tracker, result, concurrency, dryRun, abortCheck);
          break;
        case "og_image":
          await collectOgImage(req.region, vendors, tracker, result, concurrency, dryRun, abortCheck);
          break;
        case "apify":
          await collectApify(req.region, vendors, tracker, result, concurrency, dryRun, abortCheck);
          break;
      }

      // Update progress after each source
      result.progress = tracker.getProgress();
    }

    result.progress = tracker.getProgress();
    result.stopped_reason = tracker.allDone() ? "all_targets_met" : "sources_exhausted";
    job.status = job.aborted ? "stopped" : "done";
    job.finished_at = new Date().toISOString();

    log.info({
      jobId: job.id,
      uploaded: result.uploaded,
      progress: result.progress,
      stopped_reason: result.stopped_reason,
    }, "photo_bank.collect.done");
  } catch (err: any) {
    job.status = "error";
    job.error = err.message;
    job.finished_at = new Date().toISOString();
    throw err;
  }
}
