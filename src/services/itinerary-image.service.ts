import { log } from "../lib/pino-logger";
import { TripImage, TripImages } from "../types";
import { getPhotosForTrip, PhotoBankRow } from "./photo-bank.service";

/* ── Types ── */

interface ParsedDayInput {
  dayNumber: number;
  type: "fishing" | "travel" | "sightseeing" | "rest" | "mixed";
  regionName: string;
  country: string;
  species: string[];
  vendors: string[];
  keyPlaces: string[];
  accommodation: string | null;
}

/* ── Helpers ── */

function mapPhotoBankRow(row: PhotoBankRow): TripImage {
  return {
    url: row.cdn_url,
    photographer: "",
    photographerUrl: "",
    photoId: row.id,
    source: "photo_bank",
    description: row.ai_description || undefined,
  };
}

/**
 * Select the best day for the hero (cover) image:
 * 1. First fishing day with lodge/charter in vendors
 * 2. First fishing day
 * 3. Day with most keyPlaces
 */
function selectHeroDay(days: ParsedDayInput[]): ParsedDayInput {
  // Priority 1: fishing day with lodge/charter vendor
  const fishingWithVendor = days.find(
    d => d.type === "fishing" && d.vendors.some(v =>
      /lodge|charter|outfitter/i.test(v)
    )
  );
  if (fishingWithVendor) return fishingWithVendor;

  // Priority 2: first fishing day
  const firstFishing = days.find(d => d.type === "fishing");
  if (firstFishing) return firstFishing;

  // Priority 3: most keyPlaces
  return [...days].sort((a, b) => b.keyPlaces.length - a.keyPlaces.length)[0];
}

/**
 * Select the footer day:
 * - Fishing day from the second fishing block (if exists)
 * - Otherwise last day
 */
function selectFooterDay(days: ParsedDayInput[]): ParsedDayInput {
  // Find fishing blocks (consecutive fishing days)
  const fishingDays = days.filter(d => d.type === "fishing");

  if (fishingDays.length >= 2) {
    // Find the start of a second fishing block
    let blockCount = 0;
    let prevWasFishing = false;

    for (const day of days) {
      const isFishing = day.type === "fishing";
      if (isFishing && !prevWasFishing) blockCount++;
      if (blockCount === 2 && isFishing) return day;
      prevWasFishing = isFishing;
    }
  }

  // Fallback: last day
  return days[days.length - 1];
}

/**
 * Determine the main fishing region — region of the first fishing day
 */
function getMainFishingRegion(days: ParsedDayInput[]): string | null {
  const fishingDay = days.find(d => d.type === "fishing");
  return fishingDay?.regionName || null;
}

/* ── Main function ── */

export async function getItineraryImages(days: ParsedDayInput[]): Promise<TripImages> {
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

  if (!days.length) return emptyResult;

  try {
    // Collect all unique species
    const allSpecies = [...new Set(days.flatMap(d => d.species))];

    // Identify key days
    const heroDay = selectHeroDay(days);
    const footerDay = selectFooterDay(days);
    const mainFishingRegion = getMainFishingRegion(days);
    const lastDay = days[days.length - 1];

    // ── Fetch photos for hero day ──
    const heroRegion = heroDay.regionName || heroDay.country;
    const heroPhotos = heroRegion
      ? await getPhotosForTrip(heroRegion, heroDay.country, heroDay.species, "fishing", 1)
      : null;

    const cover = heroPhotos?.cover
      ? mapPhotoBankRow(heroPhotos.cover)
      : (heroPhotos?.heroes?.[0] ? mapPhotoBankRow(heroPhotos.heroes[0]) : null);

    // ── Footer ──
    const footerRegion = footerDay.regionName || footerDay.country;
    let footer: TripImage | null = null;
    if (footerRegion && footerRegion !== heroRegion) {
      const footerPhotos = await getPhotosForTrip(footerRegion, footerDay.country, footerDay.species, undefined, 1);
      footer = footerPhotos?.cover ? mapPhotoBankRow(footerPhotos.cover) : null;
    } else if (heroPhotos?.heroes?.[1]) {
      footer = mapPhotoBankRow(heroPhotos.heroes[1]);
    } else if (heroPhotos?.action?.[0]) {
      footer = mapPhotoBankRow(heroPhotos.action[0]);
    }

    // ── Day photos (scenery per day, fetched per unique region) ──
    const regionCache = new Map<string, Awaited<ReturnType<typeof getPhotosForTrip>>>();
    const dayPhotos: (TripImage | null)[] = [];

    for (const day of days) {
      const region = day.regionName || day.country;
      if (!region) {
        dayPhotos.push(null);
        continue;
      }

      if (!regionCache.has(region)) {
        try {
          const photos = await getPhotosForTrip(region, day.country, day.species, undefined, days.length);
          regionCache.set(region, photos);
        } catch {
          dayPhotos.push(null);
          continue;
        }
      }

      const cached = regionCache.get(region)!;
      // Pick next unused scenery photo
      const usedCount = dayPhotos.filter(p => p !== null).length;
      const sceneryPhoto = cached.scenery[usedCount % cached.scenery.length];
      dayPhotos.push(sceneryPhoto ? mapPhotoBankRow(sceneryPhoto) : null);
    }

    // ── Bands — first 3 from collected day photos ──
    const nonNullDayPhotos = dayPhotos.filter(Boolean) as TripImage[];
    const bands: (TripImage | null)[] = [
      nonNullDayPhotos[0] || null,
      nonNullDayPhotos[1] || null,
      nonNullDayPhotos[2] || null,
    ];

    // ── Fish photos — by target species ──
    const fishPhotos: TripImage[] = [];
    if (allSpecies.length > 0 && mainFishingRegion) {
      const fishData = await getPhotosForTrip(mainFishingRegion, days[0]?.country, allSpecies, undefined, 1);
      for (const fp of fishData.fish) {
        fishPhotos.push(mapPhotoBankRow(fp));
      }
    }

    // ── Action band — action photo from main fishing region ──
    let actionBand: TripImage | null = null;
    if (mainFishingRegion) {
      const actionData = heroPhotos || await getPhotosForTrip(mainFishingRegion, days[0]?.country, undefined, "fishing", 1);
      actionBand = actionData?.action?.[0] ? mapPhotoBankRow(actionData.action[0]) : null;
    }

    // ── Gear band — band photo from main fishing region ──
    let gearBand: TripImage | null = null;
    if (mainFishingRegion) {
      const gearData = heroPhotos || await getPhotosForTrip(mainFishingRegion, days[0]?.country, undefined, undefined, 1);
      gearBand = gearData?.bands?.[0] ? mapPhotoBankRow(gearData.bands[0]) : null;
    }

    // ── Season band — scenery from last day ──
    let seasonBand: TripImage | null = null;
    const lastRegion = lastDay.regionName || lastDay.country;
    if (lastRegion) {
      const lastData = regionCache.get(lastRegion)
        || await getPhotosForTrip(lastRegion, lastDay.country, undefined, undefined, 1);
      const lastScenery = lastData.scenery[lastData.scenery.length - 1];
      seasonBand = lastScenery ? mapPhotoBankRow(lastScenery) : null;
    }

    log.info(
      {
        hasCover: !!cover,
        hasFooter: !!footer,
        dayPhotos: dayPhotos.filter(Boolean).length,
        fishPhotos: fishPhotos.length,
        hasAction: !!actionBand,
        hasGear: !!gearBand,
        hasSeason: !!seasonBand,
      },
      "[ItineraryImage] Photo set assembled from Photo Bank",
    );

    return { cover, bands, dayPhotos, fishPhotos, footer, actionBand, gearBand, seasonBand };
  } catch (err) {
    log.error({ err }, "[ItineraryImage] Failed to build image set");
    return emptyResult;
  }
}
