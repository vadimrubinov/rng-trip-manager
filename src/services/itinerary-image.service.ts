import { log } from "../lib/pino-logger";
import { TripImage, TripImages } from "../types";
import { getPhotosForTrip, PhotoBankRow } from "./photo-bank-readonly.service";

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

/* ── Default photos (neutral, work for any trip) ──────────────────────────────
 * Stored in S3 rng-bitescout-backups bucket under defaults/ prefix.
 * Replace URLs here when uploading real approved photos.
 * Structure: one array per slot type, first element is primary default.
 * ─────────────────────────────────────────────────────────────────────────── */

const S3_BASE = "https://rng-bitescout-backups.s3.us-east-1.amazonaws.com/photo-defaults";

const DEFAULT_PHOTOS = {
  // Hero / cover — wide landscape with fishing boat or trophy catch
  cover: [
    { url: `${S3_BASE}/cover-01.jpg`, label: "Fishing boat on open water" },
    { url: `${S3_BASE}/cover-02.jpg`, label: "Trophy catch at sea" },
    { url: `${S3_BASE}/cover-03.jpg`, label: "Sunrise on the water" },
  ],

  // Footer — second hero, different mood from cover
  footer: [
    { url: `${S3_BASE}/footer-01.jpg`, label: "Scenic coastline" },
    { url: `${S3_BASE}/footer-02.jpg`, label: "Fishing crew on deck" },
  ],

  // Day photos by day type — one per slot
  dayFishing:    { url: `${S3_BASE}/day-fishing.jpg`,    label: "Fishing day" },
  dayTravel:     { url: `${S3_BASE}/day-travel.jpg`,     label: "Travel day" },
  daySightseeing:{ url: `${S3_BASE}/day-sightseeing.jpg`,label: "Sightseeing day" },
  dayRest:       { url: `${S3_BASE}/day-rest.jpg`,       label: "Rest day" },
  dayMixed:      { url: `${S3_BASE}/day-mixed.jpg`,      label: "Mixed day" },

  // Bands
  actionBand:  { url: `${S3_BASE}/band-action.jpg`,  label: "Action fishing" },
  gearBand:    { url: `${S3_BASE}/band-gear.jpg`,    label: "Fishing gear" },
  seasonBand:  { url: `${S3_BASE}/band-season.jpg`,  label: "Scenic season" },

  // Fish photo — generic trophy fish
  fish: { url: `${S3_BASE}/fish-trophy.jpg`, label: "Trophy fish" },
};

function makeDefault(entry: { url: string; label: string }): TripImage {
  return {
    url: entry.url,
    photographer: "",
    photographerUrl: "",
    source: "photo_bank",
    description: entry.label,
  };
}

function defaultDayPhoto(type: ParsedDayInput["type"]): TripImage {
  const map: Record<ParsedDayInput["type"], { url: string; label: string }> = {
    fishing:     DEFAULT_PHOTOS.dayFishing,
    travel:      DEFAULT_PHOTOS.dayTravel,
    sightseeing: DEFAULT_PHOTOS.daySightseeing,
    rest:        DEFAULT_PHOTOS.dayRest,
    mixed:       DEFAULT_PHOTOS.dayMixed,
  };
  return makeDefault(map[type] || DEFAULT_PHOTOS.dayMixed);
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

function selectHeroDay(days: ParsedDayInput[]): ParsedDayInput {
  const fishingWithVendor = days.find(
    d => d.type === "fishing" && d.vendors.some(v =>
      /lodge|charter|outfitter/i.test(v)
    )
  );
  if (fishingWithVendor) return fishingWithVendor;
  const firstFishing = days.find(d => d.type === "fishing");
  if (firstFishing) return firstFishing;
  return [...days].sort((a, b) => b.keyPlaces.length - a.keyPlaces.length)[0];
}

function selectFooterDay(days: ParsedDayInput[]): ParsedDayInput {
  const fishingDays = days.filter(d => d.type === "fishing");
  if (fishingDays.length >= 2) {
    let blockCount = 0;
    let prevWasFishing = false;
    for (const day of days) {
      const isFishing = day.type === "fishing";
      if (isFishing && !prevWasFishing) blockCount++;
      if (blockCount === 2 && isFishing) return day;
      prevWasFishing = isFishing;
    }
  }
  return days[days.length - 1];
}

function getMainFishingRegion(days: ParsedDayInput[]): string | null {
  return days.find(d => d.type === "fishing")?.regionName || null;
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
    const allSpecies = [...new Set(days.flatMap(d => d.species))];
    const heroDay = selectHeroDay(days);
    const footerDay = selectFooterDay(days);
    const mainFishingRegion = getMainFishingRegion(days);
    const lastDay = days[days.length - 1];

    // ── Cover ──
    const heroRegion = heroDay.regionName || heroDay.country;
    let cover: TripImage | null = null;
    if (heroRegion) {
      try {
        const heroPhotos = await getPhotosForTrip(heroRegion, heroDay.country, heroDay.species, "fishing", 1);
        cover = heroPhotos?.cover ? mapPhotoBankRow(heroPhotos.cover) : null;
      } catch { /* fallthrough to default */ }
    }
    cover = cover || makeDefault(DEFAULT_PHOTOS.cover[0]);

    // ── Footer ──
    let footer: TripImage | null = null;
    const footerRegion = footerDay.regionName || footerDay.country;
    if (footerRegion && footerRegion !== heroRegion) {
      try {
        const footerPhotos = await getPhotosForTrip(footerRegion, footerDay.country, footerDay.species, undefined, 1);
        footer = footerPhotos?.cover ? mapPhotoBankRow(footerPhotos.cover) : null;
      } catch { /* fallthrough */ }
    }
    footer = footer || makeDefault(DEFAULT_PHOTOS.footer[0]);

    // ── Day photos — per day, per region, with type-based default fallback ──
    const regionCache = new Map<string, Awaited<ReturnType<typeof getPhotosForTrip>>>();
    const dayPhotos: (TripImage | null)[] = [];

    for (const day of days) {
      const region = day.regionName || day.country;
      if (!region) {
        dayPhotos.push(defaultDayPhoto(day.type));
        continue;
      }

      if (!regionCache.has(region)) {
        try {
          const photos = await getPhotosForTrip(region, day.country, day.species, undefined, days.length);
          regionCache.set(region, photos);
        } catch {
          dayPhotos.push(defaultDayPhoto(day.type));
          continue;
        }
      }

      const cached = regionCache.get(region)!;
      const usedCount = dayPhotos.filter(Boolean).length;
      const sceneryPhoto = cached.scenery[usedCount % Math.max(cached.scenery.length, 1)];
      dayPhotos.push(sceneryPhoto ? mapPhotoBankRow(sceneryPhoto) : defaultDayPhoto(day.type));
    }

    // ── Bands ──
    const nonNullDayPhotos = dayPhotos.filter(Boolean) as TripImage[];
    const bands: (TripImage | null)[] = [
      nonNullDayPhotos[0] || makeDefault(DEFAULT_PHOTOS.cover[1]),
      nonNullDayPhotos[1] || makeDefault(DEFAULT_PHOTOS.cover[2]),
      nonNullDayPhotos[2] || makeDefault(DEFAULT_PHOTOS.footer[1]),
    ];

    // ── Fish photos ──
    const fishPhotos: TripImage[] = [];
    if (allSpecies.length > 0 && mainFishingRegion) {
      try {
        const fishData = await getPhotosForTrip(mainFishingRegion, days[0]?.country, allSpecies, undefined, 1);
        for (const fp of fishData.fish) fishPhotos.push(mapPhotoBankRow(fp));
      } catch { /* fallthrough */ }
    }
    if (fishPhotos.length === 0) fishPhotos.push(makeDefault(DEFAULT_PHOTOS.fish));

    // ── Action band ──
    let actionBand: TripImage | null = null;
    if (mainFishingRegion) {
      try {
        const actionData = await getPhotosForTrip(mainFishingRegion, days[0]?.country, undefined, "fishing", 1);
        actionBand = actionData?.action?.[0] ? mapPhotoBankRow(actionData.action[0]) : null;
      } catch { /* fallthrough */ }
    }
    actionBand = actionBand || makeDefault(DEFAULT_PHOTOS.actionBand);

    // ── Gear band ──
    let gearBand: TripImage | null = null;
    if (mainFishingRegion) {
      try {
        const gearData = await getPhotosForTrip(mainFishingRegion, days[0]?.country, undefined, undefined, 1);
        gearBand = gearData?.bands?.[0] ? mapPhotoBankRow(gearData.bands[0]) : null;
      } catch { /* fallthrough */ }
    }
    gearBand = gearBand || makeDefault(DEFAULT_PHOTOS.gearBand);

    // ── Season band ──
    let seasonBand: TripImage | null = null;
    const lastRegion = lastDay.regionName || lastDay.country;
    if (lastRegion) {
      try {
        const lastData = regionCache.get(lastRegion)
          || await getPhotosForTrip(lastRegion, lastDay.country, undefined, undefined, 1);
        const lastScenery = lastData.scenery[lastData.scenery.length - 1];
        seasonBand = lastScenery ? mapPhotoBankRow(lastScenery) : null;
      } catch { /* fallthrough */ }
    }
    seasonBand = seasonBand || makeDefault(DEFAULT_PHOTOS.seasonBand);

    const fromBank = dayPhotos.filter(p => p?.source === "photo_bank").length;
    const fromDefault = dayPhotos.filter(p => p?.source === "photo_bank" && p?.photoId === undefined).length;
    log.info(
      { hasCover: !!cover, hasFooter: !!footer, dayPhotos: dayPhotos.length, fromBank, fromDefault },
      "[ItineraryImage] Photo set assembled",
    );

    return { cover, bands, dayPhotos, fishPhotos, footer, actionBand, gearBand, seasonBand };
  } catch (err) {
    log.error({ err }, "[ItineraryImage] Failed to build image set");
    return emptyResult;
  }
}
