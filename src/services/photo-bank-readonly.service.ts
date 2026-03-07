import { pool } from "../db/pool";

// ── Types (subset for trip landing page) ──

export type PhotoCategory = "hero" | "landscape" | "square" | "portrait";

// Transition mapping: new name → [new, old] for backward compat during migration
const CATEGORY_COMPAT: Record<PhotoCategory, string[]> = {
  hero:      ["hero"],
  landscape: ["landscape", "scenery"],
  square:    ["square", "action"],
  portrait:  ["portrait", "fish"],
};

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
  source: string;
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

// ── Trip type keyword mapping ──

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

// ── Read-only photo queries for trip landing pages ──

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
  square: PhotoBankRow[];
  landscape: PhotoBankRow[];
  portrait: PhotoBankRow[];
}> {
  const baseCondition = `approved = TRUE`;

  async function findByCategory(category: PhotoCategory, limit: number, species?: string): Promise<PhotoBankRow[]> {
    const fetchLimit = tripType ? Math.max(limit * 5, 20) : limit;
    const cats = CATEGORY_COMPAT[category];

    let { rows } = await pool.query(
      `SELECT * FROM photo_bank
       WHERE ${baseCondition} AND category = ANY($1::text[]) AND LOWER(region) = LOWER($2)
       ${species ? "AND LOWER(species) = LOWER($3)" : ""}
       ORDER BY ai_score DESC NULLS LAST, created_at DESC
       LIMIT $${species ? 4 : 3}`,
      species ? [cats, region, species, fetchLimit] : [cats, region, fetchLimit],
    );

    if (rows.length === 0 && country) {
      const res = await pool.query(
        `SELECT * FROM photo_bank
         WHERE ${baseCondition} AND category = ANY($1::text[]) AND LOWER(country) = LOWER($2)
         ${species ? "AND LOWER(species) = LOWER($3)" : ""}
         ORDER BY ai_score DESC NULLS LAST, created_at DESC
         LIMIT $${species ? 4 : 3}`,
        species ? [cats, country, species, fetchLimit] : [cats, country, fetchLimit],
      );
      rows = res.rows;
    }

    if (rows.length === 0) {
      const res = await pool.query(
        `SELECT * FROM photo_bank
         WHERE ${baseCondition} AND category = ANY($1::text[])
         ORDER BY ai_score DESC NULLS LAST, created_at DESC
         LIMIT $2`,
        [cats, fetchLimit],
      );
      rows = res.rows;
    }

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

  const landscapeLimit = Math.max(dayCount || 3, 5) + 1;

  const [heroes, squares, landscapes] = await Promise.all([
    findByCategory("hero", 2),
    findByCategory("square", 3),
    findByCategory("landscape", landscapeLimit),
  ]);

  let portraits: PhotoBankRow[] = [];
  if (targetSpecies?.length) {
    for (const sp of targetSpecies.slice(0, 3)) {
      const photos = await findByCategory("portrait", 1, sp);
      portraits.push(...photos);
    }
  }
  if (portraits.length === 0) {
    portraits = await findByCategory("portrait", 2);
  }

  return {
    cover: heroes[0] || null,
    heroes,
    bands: [],
    square: squares,
    landscape: landscapes,
    portrait: portraits,
  };
}
