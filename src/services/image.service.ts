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

function buildSearchQuery(region?: string, targetSpecies?: string[], tripType?: string): string {
  // Try most specific first, then broaden
  const parts: string[] = [];

  if (tripType && tripType !== "other") {
    parts.push(tripType);
  }

  parts.push("fishing");

  if (region) {
    // Clean region: "Alaska, US" → "Alaska"
    const cleanRegion = region.split(",")[0].trim();
    parts.push(cleanRegion);
  } else if (targetSpecies?.length) {
    parts.push(targetSpecies[0]);
  }

  return parts.join(" ");
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

  const data: PexelsSearchResponse = await res.json();
  return data.photos || [];
}

export async function getTripImages(
  region?: string,
  targetSpecies?: string[],
  tripType?: string,
): Promise<TripImages> {
  const emptyResult: TripImages = { cover: null, bands: [null, null, null] };

  try {
    const query = buildSearchQuery(region, targetSpecies, tripType);
    log.info({ query, region, tripType }, "[ImageService] Searching Pexels");

    let photos = await searchPexels(query, 5);

    // Fallback: if too few results, try broader query
    if (photos.length < 4) {
      const fallbackQuery = "sport fishing landscape";
      log.info({ fallbackQuery, originalResults: photos.length }, "[ImageService] Broadening search");
      const fallbackPhotos = await searchPexels(fallbackQuery, 5);
      // Merge: keep originals first, fill with fallback
      const existing = new Set(photos.map((p) => p.id));
      for (const p of fallbackPhotos) {
        if (!existing.has(p.id)) photos.push(p);
      }
    }

    if (photos.length === 0) {
      log.warn("[ImageService] No photos found");
      return emptyResult;
    }

    return {
      cover: photos[0] ? mapPhoto(photos[0], "large2x") : null,
      bands: [
        photos[1] ? mapPhoto(photos[1], "large") : null,
        photos[2] ? mapPhoto(photos[2], "large") : null,
        photos[3] ? mapPhoto(photos[3], "large") : null,
      ],
    };
  } catch (err) {
    log.error({ err }, "[ImageService] Failed to fetch images");
    return emptyResult;
  }
}
