import { log } from "../lib/pino-logger";
import { ENV } from "../config/env";
import { TripImage, TripImages } from "../types";

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
  return /^[\x00-\x7F\s.,\-()]+$/.test(text);
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

  // Query 1: species + fishing + location (most specific)
  if (englishSpecies.length && (cleanRegion || cleanCountry)) {
    queries.push(`${englishSpecies[0]} fishing ${cleanRegion || cleanCountry}`);
  }

  // Query 2: type + fishing + location
  if (usefulType && (cleanRegion || cleanCountry)) {
    queries.push(`${usefulType} fishing ${cleanRegion || cleanCountry}`);
  }

  // Query 3: fishing + location
  if (cleanRegion) {
    queries.push(`fishing ${cleanRegion} ${cleanCountry}`.trim());
  } else if (cleanCountry) {
    queries.push(`fishing ${cleanCountry}`);
  }

  // Query 4: species fishing (no location)
  if (englishSpecies.length) {
    queries.push(`${englishSpecies[0]} fishing`);
  }

  // Ultimate fallback
  if (queries.length === 0) {
    queries.push("sport fishing ocean");
  }

  return queries;
}

function mapPhoto(photo: PexelsPhoto, size: "large2x" | "large"): TripImage {
  return {
    url: photo.src[size],
    photographer: photo.photographer,
    photographerUrl: photo.photographer_url,
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

export async function getTripImages(
  region?: string,
  targetSpecies?: string[],
  tripType?: string,
  country?: string,
): Promise<TripImages> {
  const emptyResult: TripImages = { cover: null, bands: [null, null, null] };

  try {
    const queries = buildSearchQueries(region, country, targetSpecies, tripType);
    log.info({ queries, region, country, tripType }, "[ImageService] Searching Pexels");

    const allPhotos: PexelsPhoto[] = [];
    const seenIds = new Set<number>();

    for (const query of queries) {
      if (allPhotos.length >= 5) break;

      const photos = await searchPexels(query, 5);
      for (const p of photos) {
        if (!seenIds.has(p.id)) {
          seenIds.add(p.id);
          allPhotos.push(p);
        }
      }
    }

    if (allPhotos.length < 4) {
      const fallback = await searchPexels("sport fishing boat ocean", 5);
      for (const p of fallback) {
        if (!seenIds.has(p.id)) {
          seenIds.add(p.id);
          allPhotos.push(p);
        }
      }
    }

    if (allPhotos.length === 0) {
      log.warn("[ImageService] No photos found");
      return emptyResult;
    }

    return {
      cover: allPhotos[0] ? mapPhoto(allPhotos[0], "large2x") : null,
      bands: [
        allPhotos[1] ? mapPhoto(allPhotos[1], "large") : null,
        allPhotos[2] ? mapPhoto(allPhotos[2], "large") : null,
        allPhotos[3] ? mapPhoto(allPhotos[3], "large") : null,
      ],
    };
  } catch (err) {
    log.error({ err }, "[ImageService] Failed to fetch images");
    return emptyResult;
  }
}
