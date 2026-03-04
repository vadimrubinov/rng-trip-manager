import { pool } from "../db/pool";
import { ENV } from "../config/env";
import { log } from "../lib/pino-logger";

// ── Types ──────────────────────────────────────────────

export type PhotoCategory = "hero" | "band" | "action" | "scenery" | "fish";
export type PhotoSource = "md_raw" | "apify" | "og_image" | "manual" | "stock";

export interface PhotoBankRow {
  id: string;
  s3_key: string;
  cdn_url: string;
  region: string | null;
  country: string | null;
  category: PhotoCategory;
  species: string | null;
  tags: string[];
  width: number | null;
  height: number | null;
  file_size: number | null;
  source: PhotoSource;
  source_url: string | null;
  vendor_record_id: string | null;
  approved: boolean;
  approved_by: string | null;
  approved_at: string | null;
  ai_score: number | null;
  ai_category: string | null;
  ai_description: string | null;
  ai_filtered_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AddPhotoRequest {
  s3_key: string;
  cdn_url: string;
  region?: string;
  country?: string;
  category: PhotoCategory;
  species?: string;
  tags?: string[];
  width?: number;
  height?: number;
  file_size?: number;
  source: PhotoSource;
  source_url?: string;
  vendor_record_id?: string;
  ai_score?: number;
  ai_category?: string;
  ai_description?: string;
}

export interface AddCandidateRequest {
  source_url: string;
  region?: string;
  country?: string;
  category?: PhotoCategory;
  species?: string;
  tags?: string[];
  source: PhotoSource;
  vendor_record_id?: string;
  ai_score?: number;
  ai_category?: string;
  ai_description?: string;
  width?: number;
  height?: number;
}

export interface PhotoQuery {
  region?: string;
  country?: string;
  category?: PhotoCategory;
  species?: string;
  approved?: boolean;
  source?: PhotoSource;
  limit?: number;
  offset?: number;
  ai_score_min?: number;
  ai_score_max?: number;
  sort_by?: "ai_score" | "created_at";
}

// ── Trip type keyword mapping ──────────────────────────

const TRIP_TYPE_KEYWORDS: Record<string, string[]> = {
  "offshore":     ["ocean", "boat", "offshore", "deep sea", "open water", "charter", "pelagic", "saltwater"],
  "fly fishing":  ["river", "stream", "fly", "casting", "wading", "rapids", "creek", "fly fishing"],
  "inshore":      ["coast", "shore", "flat", "shallow", "mangrove", "bay", "estuary", "inshore"],
  "trolling":     ["boat", "trolling", "rod holders", "wake", "lure", "downrigger"],
  "ice fishing":  ["ice", "lake", "frozen", "winter", "snow", "ice fishing", "shanty"],
  "freshwater":   ["lake", "river", "stream", "freshwater", "pond", "reservoir"],
  "bass fishing": ["bass", "lake", "boat", "lure", "freshwater", "largemouth"],
  "saltwater":    ["ocean", "saltwater", "sea", "boat", "charter", "marine"],
  "jigging":      ["jig", "vertical", "deep", "boat", "offshore"],
  "spearfishing": ["underwater", "spear", "reef", "diving", "freediving"],
};

/**
 * Score a photo's ai_description against trip type keywords.
 * Returns 0 if no tripType or no keywords match.
 */
function scoreTripTypeMatch(description: string | null, tripType: string | undefined): number {
  if (!tripType || !description) return 0;

  const desc = description.toLowerCase();
  const keywords = TRIP_TYPE_KEYWORDS[tripType.toLowerCase()];
  if (!keywords) return 0;

  let score = 0;
  for (const kw of keywords) {
    if (desc.includes(kw)) score++;
  }
  return score;
}

// ── S3 helpers (using native fetch — no SDK needed) ──

const S3_BUCKET = ENV.S3_PHOTO_BANK_BUCKET;
const S3_REGION = ENV.AWS_REGION;
const S3_BASE_URL = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com`;

function getCdnUrl(s3Key: string): string {
  return `${S3_BASE_URL}/${s3Key}`;
}

/**
 * Upload buffer to S3 using pre-signed PUT or AWS SDK-free approach.
 * Uses native AWS Signature V4 via @aws-sdk/client-s3 (lightweight).
 */
async function uploadToS3(
  buffer: Buffer,
  s3Key: string,
  contentType: string,
): Promise<string> {
  // Dynamic import — only loads when actually uploading
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");

  const client = new S3Client({
    region: S3_REGION,
    credentials: {
      accessKeyId: ENV.AWS_ACCESS_KEY_ID,
      secretAccessKey: ENV.AWS_SECRET_ACCESS_KEY,
    },
  });

  await client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000",
    }),
  );

  return getCdnUrl(s3Key);
}

async function deleteFromS3(s3Key: string): Promise<void> {
  const { S3Client, DeleteObjectCommand } = await import("@aws-sdk/client-s3");

  const client = new S3Client({
    region: S3_REGION,
    credentials: {
      accessKeyId: ENV.AWS_ACCESS_KEY_ID,
      secretAccessKey: ENV.AWS_SECRET_ACCESS_KEY,
    },
  });

  await client.send(
    new DeleteObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
    }),
  );
}

// ── Download external image ──

export async function downloadImage(url: string): Promise<{ buffer: Buffer; contentType: string }> {
  const resp = await fetch(url, {
    headers: { "User-Agent": "BiteScout-PhotoBank/1.0" },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) throw new Error(`Download failed: ${resp.status} ${url}`);

  const contentType = resp.headers.get("content-type") || "image/jpeg";
  const arrayBuffer = await resp.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), contentType };
}

// ── DB operations ──

/** Add a photo record (already uploaded to S3) */
export async function addPhoto(req: AddPhotoRequest): Promise<PhotoBankRow> {
  const { rows } = await pool.query(
    `INSERT INTO photo_bank
       (s3_key, cdn_url, region, country, category, species, tags, width, height, file_size, source, source_url, vendor_record_id, ai_score, ai_category, ai_description, ai_filtered_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [
      req.s3_key, req.cdn_url,
      req.region || null, req.country || null,
      req.category, req.species || null,
      req.tags || [], req.width || null, req.height || null,
      req.file_size || null, req.source,
      req.source_url || null, req.vendor_record_id || null,
      req.ai_score ?? null, req.ai_category || null, req.ai_description || null,
      req.ai_score != null ? new Date().toISOString() : null,
    ],
  );
  return rows[0];
}

/** Add a candidate from URL — downloads, uploads to S3, creates DB record */
export async function addCandidate(req: AddCandidateRequest): Promise<PhotoBankRow> {
  // Download
  const { buffer, contentType } = await downloadImage(req.source_url);

  return addCandidateFromBuffer({ ...req, buffer, contentType });
}

/** Add a candidate from already-downloaded buffer — uploads to S3, creates DB record */
export async function addCandidateFromBuffer(req: AddCandidateRequest & { buffer: Buffer; contentType: string }): Promise<PhotoBankRow> {
  const { buffer, contentType } = req;

  // Determine extension
  const ext = contentType.includes("png") ? "png"
    : contentType.includes("webp") ? "webp"
    : "jpg";

  // Generate S3 key: {category}/{region_slug}/{timestamp}.{ext}
  const category = req.category || "scenery";
  const regionSlug = (req.region || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
  const ts = Date.now();
  const s3Key = `${category}/${regionSlug}/${ts}.${ext}`;

  // Upload to S3
  const cdnUrl = await uploadToS3(buffer, s3Key, contentType);

  log.info({ s3Key, source: req.source, sourceUrl: req.source_url, size: buffer.length }, "photo_bank.uploaded");

  // Create DB record (not approved yet)
  return addPhoto({
    s3_key: s3Key,
    cdn_url: cdnUrl,
    region: req.region,
    country: req.country,
    category,
    species: req.species,
    tags: req.tags,
    file_size: buffer.length,
    source: req.source,
    source_url: req.source_url,
    vendor_record_id: req.vendor_record_id,
    ai_score: req.ai_score,
    ai_category: req.ai_category,
    ai_description: req.ai_description,
  });
}

/** Query photos with filters */
export async function queryPhotos(q: PhotoQuery): Promise<{ photos: PhotoBankRow[]; total: number }> {
  const conditions: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (q.region) {
    conditions.push(`LOWER(region) = LOWER($${idx++})`);
    values.push(q.region);
  }
  if (q.country) {
    conditions.push(`LOWER(country) = LOWER($${idx++})`);
    values.push(q.country);
  }
  if (q.category) {
    conditions.push(`category = $${idx++}`);
    values.push(q.category);
  }
  if (q.species) {
    conditions.push(`LOWER(species) = LOWER($${idx++})`);
    values.push(q.species);
  }
  if (q.approved !== undefined) {
    conditions.push(`approved = $${idx++}`);
    values.push(q.approved);
  }
  if (q.source) {
    conditions.push(`source = $${idx++}`);
    values.push(q.source);
  }
  if (q.ai_score_min !== undefined) {
    conditions.push(`ai_score >= $${idx++}`);
    values.push(q.ai_score_min);
  }
  if (q.ai_score_max !== undefined) {
    conditions.push(`ai_score <= $${idx++}`);
    values.push(q.ai_score_max);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = q.limit || 50;
  const offset = q.offset || 0;
  const orderBy = q.sort_by === "ai_score" ? "ai_score DESC NULLS LAST, created_at DESC" : "approved DESC, created_at DESC";

  const [dataRes, countRes] = await Promise.all([
    pool.query(
      `SELECT * FROM photo_bank ${where} ORDER BY ${orderBy} LIMIT $${idx++} OFFSET $${idx++}`,
      [...values, limit, offset],
    ),
    pool.query(`SELECT COUNT(*)::int as total FROM photo_bank ${where}`, values),
  ]);

  return { photos: dataRes.rows, total: countRes.rows[0].total };
}

/** Get photos for a trip — approved only, by region + category + optional tripType keyword matching */
export async function getPhotosForTrip(
  region: string,
  country?: string,
  targetSpecies?: string[],
  tripType?: string,
  dayCount?: number,
): Promise<{
  cover: PhotoBankRow | null;
  heroes: PhotoBankRow[];
  bands: PhotoBankRow[];
  action: PhotoBankRow[];
  scenery: PhotoBankRow[];
  fish: PhotoBankRow[];
}> {
  const baseCondition = `approved = TRUE`;

  async function findByCategory(category: PhotoCategory, limit: number, species?: string): Promise<PhotoBankRow[]> {
    // Fetch a wider pool when tripType is provided so we can rank by keyword match
    const fetchLimit = tripType ? Math.max(limit * 5, 20) : limit;

    // Try exact region match
    let { rows } = await pool.query(
      `SELECT * FROM photo_bank
       WHERE ${baseCondition} AND category = $1 AND LOWER(region) = LOWER($2)
       ${species ? "AND LOWER(species) = LOWER($3)" : ""}
       ORDER BY ai_score DESC NULLS LAST, created_at DESC
       LIMIT $${species ? 4 : 3}`,
      species ? [category, region, species, fetchLimit] : [category, region, fetchLimit],
    );

    // Fall back to country
    if (rows.length === 0 && country) {
      const res = await pool.query(
        `SELECT * FROM photo_bank
         WHERE ${baseCondition} AND category = $1 AND LOWER(country) = LOWER($2)
         ${species ? "AND LOWER(species) = LOWER($3)" : ""}
         ORDER BY ai_score DESC NULLS LAST, created_at DESC
         LIMIT $${species ? 4 : 3}`,
        species ? [category, country, species, fetchLimit] : [category, country, fetchLimit],
      );
      rows = res.rows;
    }

    // Fall back to global pool
    if (rows.length === 0) {
      const res = await pool.query(
        `SELECT * FROM photo_bank
         WHERE ${baseCondition} AND category = $1
         ORDER BY ai_score DESC NULLS LAST, created_at DESC
         LIMIT $2`,
        [category, fetchLimit],
      );
      rows = res.rows;
    }

    // Rank by tripType keyword match if applicable
    if (tripType && rows.length > limit) {
      rows.sort((a, b) => {
        const scoreA = scoreTripTypeMatch(a.ai_description, tripType);
        const scoreB = scoreTripTypeMatch(b.ai_description, tripType);
        if (scoreB !== scoreA) return scoreB - scoreA;
        return (b.ai_score ?? 0) - (a.ai_score ?? 0);
      });
      rows = rows.slice(0, limit);
    } else {
      rows = rows.slice(0, limit);
    }

    return rows;
  }

  const sceneryLimit = Math.max(dayCount || 3, 5) + 1; // days + seasonBand

  const [heroes, bands, actions, sceneries] = await Promise.all([
    findByCategory("hero", 2),
    findByCategory("band", 1),
    findByCategory("action", 3),
    findByCategory("scenery", sceneryLimit),
  ]);

  // Fish — try each target species
  let fishPhotos: PhotoBankRow[] = [];
  if (targetSpecies?.length) {
    for (const sp of targetSpecies.slice(0, 3)) {
      const photos = await findByCategory("fish", 1, sp);
      fishPhotos.push(...photos);
    }
  }
  if (fishPhotos.length === 0) {
    fishPhotos = await findByCategory("fish", 2);
  }

  return {
    cover: heroes[0] || null,
    heroes,
    bands,
    action: actions,
    scenery: sceneries,
    fish: fishPhotos,
  };
}

/** Approve a photo */
export async function approvePhoto(id: string, approvedBy: string): Promise<PhotoBankRow | null> {
  const { rows } = await pool.query(
    `UPDATE photo_bank SET approved = TRUE, approved_by = $2, approved_at = NOW() WHERE id = $1 RETURNING *`,
    [id, approvedBy],
  );
  return rows[0] || null;
}

/** Reject (delete) a photo */
export async function rejectPhoto(id: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT s3_key FROM photo_bank WHERE id = $1`, [id]);
  if (!rows[0]) return false;

  try {
    await deleteFromS3(rows[0].s3_key);
  } catch (err) {
    log.warn({ err, s3Key: rows[0].s3_key }, "photo_bank.s3_delete_failed");
  }

  const result = await pool.query(`DELETE FROM photo_bank WHERE id = $1`, [id]);
  return (result.rowCount || 0) > 0;
}

/** Update photo metadata */
export async function updatePhoto(
  id: string,
  updates: Partial<Pick<PhotoBankRow, "region" | "country" | "category" | "species" | "tags">>,
): Promise<PhotoBankRow | null> {
  const sets: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (updates.region !== undefined) { sets.push(`region = $${idx++}`); values.push(updates.region); }
  if (updates.country !== undefined) { sets.push(`country = $${idx++}`); values.push(updates.country); }
  if (updates.category !== undefined) { sets.push(`category = $${idx++}`); values.push(updates.category); }
  if (updates.species !== undefined) { sets.push(`species = $${idx++}`); values.push(updates.species); }
  if (updates.tags !== undefined) { sets.push(`tags = $${idx++}`); values.push(updates.tags); }

  if (sets.length === 0) return null;

  values.push(id);
  const { rows } = await pool.query(
    `UPDATE photo_bank SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    values,
  );
  return rows[0] || null;
}

/** Bulk approve photos */
export async function bulkApprove(ids: string[], approvedBy: string): Promise<number> {
  if (!ids.length) return 0;
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
  const { rowCount } = await pool.query(
    `UPDATE photo_bank SET approved = TRUE, approved_by = $${ids.length + 1}, approved_at = NOW()
     WHERE id IN (${placeholders}) AND approved = FALSE`,
    [...ids, approvedBy],
  );
  return rowCount || 0;
}

/** Bulk reject (delete) photos */
export async function bulkReject(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
  const { rows } = await pool.query(
    `SELECT id, s3_key FROM photo_bank WHERE id IN (${placeholders})`,
    ids,
  );

  for (const row of rows) {
    try {
      await deleteFromS3(row.s3_key);
    } catch (err) {
      log.warn({ err, s3Key: row.s3_key }, "photo_bank.bulk_s3_delete_failed");
    }
  }

  const result = await pool.query(
    `DELETE FROM photo_bank WHERE id IN (${placeholders})`,
    ids,
  );
  return result.rowCount || 0;
}

/** Region stats — approved count by category per region */
export async function getRegionStats(): Promise<{
  regions: {
    region: string;
    hero: number;
    band: number;
    action: number;
    scenery: number;
    fish: number;
    total: number;
    pending: number;
  }[];
  totals: { total: number; approved: number; pending: number; regions: number };
}> {
  const [approvedRes, pendingRes, totalsRes] = await Promise.all([
    pool.query(
      `SELECT COALESCE(region, 'unknown') as region, category, COUNT(*)::int as c
       FROM photo_bank WHERE approved = TRUE
       GROUP BY region, category ORDER BY region`,
    ),
    pool.query(
      `SELECT COALESCE(region, 'unknown') as region, COUNT(*)::int as c
       FROM photo_bank WHERE approved = FALSE
       GROUP BY region ORDER BY region`,
    ),
    pool.query(
      `SELECT COUNT(*)::int as total,
              SUM(CASE WHEN approved THEN 1 ELSE 0 END)::int as approved
       FROM photo_bank`,
    ),
  ]);

  const regionMap: Record<string, { hero: number; band: number; action: number; scenery: number; fish: number; total: number; pending: number }> = {};

  for (const r of approvedRes.rows) {
    if (!regionMap[r.region]) regionMap[r.region] = { hero: 0, band: 0, action: 0, scenery: 0, fish: 0, total: 0, pending: 0 };
    const cat = r.category as string;
    if (cat in regionMap[r.region]) (regionMap[r.region] as any)[cat] = r.c;
    regionMap[r.region].total += r.c;
  }

  for (const r of pendingRes.rows) {
    if (!regionMap[r.region]) regionMap[r.region] = { hero: 0, band: 0, action: 0, scenery: 0, fish: 0, total: 0, pending: 0 };
    regionMap[r.region].pending = r.c;
  }

  const regions = Object.entries(regionMap)
    .map(([region, stats]) => ({ region, ...stats }))
    .sort((a, b) => b.total - a.total);

  const t = totalsRes.rows[0];
  return {
    regions,
    totals: {
      total: t.total || 0,
      approved: t.approved || 0,
      pending: (t.total || 0) - (t.approved || 0),
      regions: regions.length,
    },
  };
}

/** Get stats */
export async function getStats(): Promise<{
  total: number;
  approved: number;
  pending: number;
  byCategory: Record<string, number>;
  bySource: Record<string, number>;
  byRegion: { region: string; count: number }[];
}> {
  const [totalRes, approvedRes, catRes, srcRes, regRes] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int as c FROM photo_bank`),
    pool.query(`SELECT COUNT(*)::int as c FROM photo_bank WHERE approved = TRUE`),
    pool.query(`SELECT category, COUNT(*)::int as c FROM photo_bank GROUP BY category`),
    pool.query(`SELECT source, COUNT(*)::int as c FROM photo_bank GROUP BY source`),
    pool.query(`SELECT COALESCE(region, 'unknown') as region, COUNT(*)::int as c FROM photo_bank WHERE approved = TRUE GROUP BY region ORDER BY c DESC LIMIT 20`),
  ]);

  const total = totalRes.rows[0].c;
  const approved = approvedRes.rows[0].c;

  const byCategory: Record<string, number> = {};
  for (const r of catRes.rows) byCategory[r.category] = r.c;

  const bySource: Record<string, number> = {};
  for (const r of srcRes.rows) bySource[r.source] = r.c;

  return {
    total,
    approved,
    pending: total - approved,
    byCategory,
    bySource,
    byRegion: regRes.rows.map((r: any) => ({ region: r.region, count: r.c })),
  };
}
