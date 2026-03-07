import { log } from "../lib/pino-logger";
import { ENV } from "../config/env";
import { TripImage, TripImages } from "../types";
import { getPhotosForTrip, PhotoBankRow } from "./photo-bank-readonly.service";

const PEXELS_BASE = "https://api.pexels.com/v1";

interface PexelsPhoto {
  id: number;
  photographer: string;
  photographer_url: string;
  src: {
    original: string;
    large2x: string;
    large: string;
    medium: string;
  };
  alt: string;
}

interface PexelsSearchResponse {
  photos: PexelsPhoto[];
  total_results: number;
}

const USELESS_TRIP_TYPES = new Set(["other", "mixed", "custom", "general"]);

const SPECIES_MAP: Record<string, string> = {
  "лосось": "salmon", "тунец": "tuna", "форель": "trout",
  "щука": "pike", "окунь": "perch", "судак": "walleye",
  "марлин": "marlin", "тарпон": "tarpon", "махи-махи": "mahi mahi",
  "дорадо": "dorado", "палтус": "halibut", "треска": "cod",
  "сёмга": "salmon", "кижуч": "coho salmon", "чавыча": "king salmon",
  "нерка": "sockeye salmon", "горбуша": "pink salmon",
  "сиг": "whitefish", "хариус": "grayling", "карп": "carp",
  "сом": "catfish", "басс": "bass", "групер": "grouper",
};

function isLatin(text: string): boolean {
  return /^[\x00-\x7F\s.,\-()+]+$/.test(text);
}

function translateSpecies(species: string): string {
  const lower = species.toLowerCase().trim();
  return SPECIES_MAP[lower] || (isLatin(species) ? species : "");
}

function buildSearchQueries(
  region?: string,
  country?: string,
  targetSpecies?: string[],
  tripType?: string,
): string[] {
  const queries: string[] = [];

  let cleanRegion = "";
  if (region) {
    const first = region.split(",")[0].trim();
    cleanRegion = isLatin(first) ? first : "";
  }

  const cleanCountry = country && isLatin(country) ? country.trim() : "";

  const englishSpecies = (targetSpecies || [])
    .map(translateSpecies)
    .filter(Boolean);

  const usefulType = tripType && !USELESS_TRIP_TYPES.has(tripType.toLowerCase()) && isLatin(tripType)
    ? tripType
    : "";

  if (englishSpecies.length && (cleanRegion || cleanCountry)) {
    queries.push(`${englishSpecies[0]} fishing ${cleanRegion || cleanCountry}`);
  }
  if (usefulType && (cleanRegion || cleanCountry)) {
    queries.push(`${usefulType} fishing ${cleanRegion || cleanCountry}`);
  }
  if (cleanRegion) {
    queries.push(`fishing ${cleanRegion} ${cleanCountry}`.trim());
  } else if (cleanCountry) {
    queries.push(`fishing ${cleanCountry}`);
  }
  if (englishSpecies.length) {
    queries.push(`${englishSpecies[0]} fishing`);
  }
  if (queries.length === 0) {
    queries.push("sport fishing ocean");
  }

  return queries;
}

function mapPexelsPhoto(photo: PexelsPhoto, size: "large2x" | "large"): TripImage {
  return {
    url: photo.src[size],
    photographer: photo.photographer,
    photographerUrl: photo.photographer_url,
    source: "pexels",
  };
}

function mapPhotoBankRow(row: PhotoBankRow, size: "large2x" | "large"): TripImage {
  return {
    url: row.cdn_url,
    photographer: "",
    photographerUrl: "",
    photoId: row.id,
    source: "photo_bank",
    description: row.ai_description || undefined,
  };
}

async function searchPexels(query: string, perPage: number = 5): Promise<PexelsPhoto[]> {
  if (!ENV.PEXELS_API_KEY) {
    log.warn("[ImageService] PEXELS_API_KEY not set, skipping image fetch");
    return [];
  }

  const url = `${PEXELS_BASE}/search?query=${encodeURIComponent(query)}&orientation=landscape&per_page=${perPage}`;

  const res = await fetch(url, {
    headers: { Authorization: ENV.PEXELS_API_KEY },
  });

  if (!res.ok) {
    log.error({ status: res.status, query }, "[ImageService] Pexels API error");
    return [];
  }

  const data = (await res.json()) as PexelsSearchResponse;
  return data.photos || [];
}

async function getPexelsFallback(
  region?: string,
  targetSpecies?: string[],
  tripType?: string,
  country?: string,
  needed: number = 4,
): Promise<PexelsPhoto[]> {
  const queries = buildSearchQueries(region, country, targetSpecies, tripType);
  const allPhotos: PexelsPhoto[] = [];
  const seenIds = new Set<number>();

  for (const query of queries) {
    if (allPhotos.length >= needed) break;
    const photos = await searchPexels(query, 5);
    for (const p of photos) {
      if (!seenIds.has(p.id)) {
        seenIds.add(p.id);
        allPhotos.push(p);
      }
    }
  }

  if (allPhotos.length < needed) {
    const fallback = await searchPexels("sport fishing boat ocean", 5);
    for (const p of fallback) {
      if (!seenIds.has(p.id)) {
        seenIds.add(p.id);
        allPhotos.push(p);
      }
    }
  }

  return allPhotos;
}

export async function getTripImages(
  region?: string,
  targetSpecies?: string[],
  tripType?: string,
  country?: string,
  dayCount?: number,
): Promise<TripImages> {
  const emptyResult: TripImages = {
    cover: null,
    bands: [null, null, null],
    dayPhotos: [],
    fishPhotos: [],
    footer: null,
    actionBand: null,
    gearBand: null,
    seasonBand: null,
  };

  try {
    // ── 1. Try Photo Bank first ──────────────────────────
    if (region || country) {
      try {
        const bankPhotos = await getPhotosForTrip(
          region || country || "",
          country,
          targetSpecies,
          tripType,
          dayCount,
        );

        const cover = bankPhotos.cover;

        const hasCover = !!cover;
        const hasEnoughPhotos = bankPhotos.square.length + bankPhotos.landscape.length + bankPhotos.bands.length >= 2;

        if (hasCover || hasEnoughPhotos) {
          // ── Build expanded photo set from bank ──
          const coverImage = cover ? mapPhotoBankRow(cover, "large2x") : null;

          // Footer — second hero different from cover, or fallback to action/scenery
          const footerRow = bankPhotos.heroes.find(h => h.id !== cover?.id)
            || bankPhotos.square[1]
            || bankPhotos.landscape[bankPhotos.landscape.length - 1]
            || null;
          const footer = footerRow ? mapPhotoBankRow(footerRow, "large2x") : null;

          // Square band — first square photo (used as action band on landing)
          const actionBand = bankPhotos.square[0] ? mapPhotoBankRow(bankPhotos.square[0], "large") : null;

          // Gear band — first band photo
          const gearBand = bankPhotos.bands[0] ? mapPhotoBankRow(bankPhotos.bands[0], "large") : null;

          // Day photos — scenery, one per day
          const dc = dayCount || 0;
          const landscapeForDays = bankPhotos.landscape.slice(0, dc);
          const dayPhotos: (TripImage | null)[] = Array.from({ length: dc }, (_, i) =>
            landscapeForDays[i] ? mapPhotoBankRow(landscapeForDays[i], "large") : null
          );

          // Season band — next scenery after day photos
          const seasonRow = bankPhotos.landscape[landscapeForDays.length] || null;
          const seasonBand = seasonRow ? mapPhotoBankRow(seasonRow, "large") : null;

          // Fish photos
          const fishPhotos = bankPhotos.portrait.map(f => mapPhotoBankRow(f, "large"));

          // Bands for backward compatibility
          const bandCandidates = [
            ...bankPhotos.square,
            ...bankPhotos.landscape,
            ...bankPhotos.bands,
          ].filter(Boolean) as PhotoBankRow[];
          const bands: (TripImage | null)[] = [
            bandCandidates[0] ? mapPhotoBankRow(bandCandidates[0], "large") : null,
            bandCandidates[1] ? mapPhotoBankRow(bandCandidates[1], "large") : null,
            bandCandidates[2] ? mapPhotoBankRow(bandCandidates[2], "large") : null,
          ];

          log.info(
            { region, country, tripType, source: "photo_bank", dayPhotos: dayPhotos.filter(Boolean).length, portrait: fishPhotos.length },
            "[ImageService] Serving expanded set from Photo Bank",
          );

          return { cover: coverImage, bands, dayPhotos, fishPhotos, footer, actionBand, gearBand, seasonBand };
        }
      } catch (bankErr) {
        log.warn({ bankErr }, "[ImageService] Photo Bank query failed, falling back to Pexels");
      }
    }

    // ── 2. Pexels fallback ───────────────────────────────
    log.info({ region, country, tripType, source: "pexels_fallback" }, "[ImageService] Photo Bank empty — using Pexels");

    const pexelsPhotos = await getPexelsFallback(region, targetSpecies, tripType, country, 4);

    if (pexelsPhotos.length === 0) {
      log.warn("[ImageService] No photos found from any source");
      return emptyResult;
    }

    return {
      cover: pexelsPhotos[0] ? mapPexelsPhoto(pexelsPhotos[0], "large2x") : null,
      bands: [
        pexelsPhotos[1] ? mapPexelsPhoto(pexelsPhotos[1], "large") : null,
        pexelsPhotos[2] ? mapPexelsPhoto(pexelsPhotos[2], "large") : null,
        pexelsPhotos[3] ? mapPexelsPhoto(pexelsPhotos[3], "large") : null,
      ],
      dayPhotos: [],
      fishPhotos: [],
      footer: null,
      actionBand: null,
      gearBand: null,
      seasonBand: null,
    };
  } catch (err) {
    log.error({ err }, "[ImageService] Failed to fetch images");
    return emptyResult;
  }
}
