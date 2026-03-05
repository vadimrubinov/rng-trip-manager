import { log } from "../lib/pino-logger";
import { airtable, getModel } from "../lib/airtable";
import { generateText } from "../lib/openai";
import { GeneratedPlan, CreateTaskRequest, CreateLocationRequest, ItineraryDay, TripImages } from "../types";
import { withRetry } from "../lib/retry";
import { getItineraryImages } from "./itinerary-image.service";

/* ── Types ── */

interface ParsedDay {
  dayNumber: number;
  dateRaw: string | null;
  date?: string; // ISO "2025-08-06" — filled by fillMissingDates
  title: string;
  description: string;
  type: "fishing" | "travel" | "sightseeing" | "rest" | "mixed";
  regionName: string;
  country: string;
  accommodation: string | null;
  vendors: string[];
  species: string[];
  keyPlaces: string[];
  transportNotes: string | null;
}

interface ProjectMeta {
  title: string;
  region: string;
  country: string;
  datesStart: string;
  datesEnd: string;
  targetSpecies: string[];
  tripType: string;
  latitude?: number;
  longitude?: number;
}

/* ── LLM helper (same pattern as planner.service) ── */

async function runPass(promptKey: string, userMessage: string, model: string, temperature: number): Promise<any> {
  const prompt = await airtable.getPrompt(promptKey);
  if (!prompt) throw new Error(`Prompt "${promptKey}" not found or inactive`);

  const text = await withRetry(
    async () => generateText(prompt, userMessage, model, temperature),
    { operationName: `itinerary.${promptKey}`, maxAttempts: 2 },
  );

  try {
    return JSON.parse(text.replace(/```json\n?|```\n?/g, "").trim());
  } catch {
    log.error({ promptKey, preview: text.slice(0, 500) }, "[ItineraryPlanner] Invalid JSON from pass");
    throw new Error(`Pass "${promptKey}" returned invalid JSON`);
  }
}

/* ── Pass A: Parse & Structure ── */

async function parseItinerary(rawItinerary: string, model: string): Promise<ParsedDay[]> {
  const trimmed = rawItinerary.slice(0, 12000);
  const parsed = await runPass("itinerary_parse", trimmed, model, 0);

  if (!Array.isArray(parsed)) {
    log.error({ type: typeof parsed }, "[ItineraryPlanner] Pass A returned non-array");
    throw new Error("Pass A (parse) did not return an array");
  }

  return parsed.map((d: any, i: number) => ({
    dayNumber: d.dayNumber ?? i + 1,
    dateRaw: d.dateRaw || null,
    title: d.title || `Day ${d.dayNumber ?? i + 1}`,
    description: d.description || "",
    type: d.type || "mixed",
    regionName: d.regionName || "",
    country: d.country || "",
    accommodation: d.accommodation || null,
    vendors: Array.isArray(d.vendors) ? d.vendors : [],
    species: Array.isArray(d.species) ? d.species : [],
    keyPlaces: Array.isArray(d.keyPlaces) ? d.keyPlaces : [],
    transportNotes: d.transportNotes || null,
  }));
}

/* ── Date filling (programmatic, no LLM) ── */

function parseRawDate(dateRaw: string): Date | null {
  if (!dateRaw) return null;

  // Normalize: "August 9th" → "August 9", "Август 14" → try parsing
  const cleaned = dateRaw
    .replace(/(\d+)(st|nd|rd|th)/gi, "$1")
    .replace(/\./g, " ")
    .trim();

  // Month name mapping (EN + RU)
  const MONTHS: Record<string, number> = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
    jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    январ: 0, феврал: 1, март: 2, апрел: 3, мая: 4, май: 4, июн: 5, июл: 6,
    август: 7, сентябр: 8, октябр: 9, ноябр: 10, декабр: 11,
  };

  // Try "Month Day" or "Day Month" — ignore any year in the raw string
  const parts = cleaned.split(/[\s,]+/).filter(Boolean);

  let month = -1;
  let day = -1;

  for (const part of parts) {
    const num = parseInt(part, 10);
    if (!isNaN(num)) {
      // Skip years (4-digit numbers or numbers > 31) — always use current year
      if (num > 31) continue;
      if (day === -1) day = num;
    } else {
      const lower = part.toLowerCase();
      for (const [key, val] of Object.entries(MONTHS)) {
        if (lower.startsWith(key) || key.startsWith(lower)) {
          month = val;
          break;
        }
      }
    }
  }

  if (month === -1 || day === -1) return null;

  // Always use current year; if the resulting date is in the past, advance to next year
  const now = new Date();
  let year = now.getFullYear();
  const candidate = new Date(year, month, day);
  if (candidate < now) {
    year += 1;
  }
  return new Date(year, month, day);
}

function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function fillMissingDates(days: ParsedDay[]): ParsedDay[] {
  if (days.length === 0) return days;

  // 1. Find anchor — first day with a parseable dateRaw
  let anchorIdx = -1;
  let anchorDate: Date | null = null;

  for (let i = 0; i < days.length; i++) {
    if (days[i].dateRaw) {
      const parsed = parseRawDate(days[i].dateRaw!);
      if (parsed) {
        anchorIdx = i;
        anchorDate = parsed;
        break;
      }
    }
  }

  // No anchor found — can't fill dates, leave empty
  if (!anchorDate || anchorIdx === -1) {
    log.warn("[ItineraryPlanner] No parseable date found in itinerary — dates will be empty");
    return days;
  }

  // 2. Calculate dates relative to anchor
  for (let i = 0; i < days.length; i++) {
    const diff = i - anchorIdx;
    const d = new Date(anchorDate.getTime());
    d.setDate(d.getDate() + diff);
    days[i].date = toISO(d);
  }

  return days;
}

/* ── Pass B: Enrich Day ── */

function mapDayType(type: string): "offshore" | "rest" | "travel" {
  if (type === "fishing") return "offshore";
  if (type === "rest") return "rest";
  return "travel"; // travel, sightseeing, mixed
}

async function enrichDay(day: ParsedDay, model: string): Promise<ItineraryDay> {
  const enriched = await runPass("itinerary_enrich_day", JSON.stringify(day), model, 0.1);

  return {
    dayNumber: enriched.dayNumber ?? day.dayNumber,
    title: enriched.title || day.title,
    description: enriched.description || day.description,
    type: enriched.type || mapDayType(day.type),
    activities: Array.isArray(enriched.activities) ? enriched.activities : [],
    highlights: Array.isArray(enriched.highlights) ? enriched.highlights : [],
    accommodation: enriched.accommodation || (day.accommodation ? { name: day.accommodation } : null),
  };
}

/* ── Pass C: Locations ── */

async function extractLocations(days: ParsedDay[], model: string): Promise<CreateLocationRequest[]> {
  const input = days.map(d => ({
    dayNumber: d.dayNumber,
    regionName: d.regionName,
    country: d.country,
    keyPlaces: d.keyPlaces,
    accommodation: d.accommodation,
  }));

  const result = await runPass("itinerary_locations", JSON.stringify(input), model, 0);

  if (!Array.isArray(result)) {
    log.error("[ItineraryPlanner] Pass C returned non-array");
    return [];
  }

  return result.map((loc: any, i: number): CreateLocationRequest => ({
    name: loc.name || `Location ${i + 1}`,
    type: loc.type || "other",
    latitude: loc.latitude || 0,
    longitude: loc.longitude || 0,
    dayNumber: loc.dayNumber,
    sortOrder: loc.sortOrder || i + 1,
    notes: loc.notes || undefined,
  }));
}

/* ── Pass D: Tasks ── */

function resolveDeadline(tripStart: string | undefined, relativeDays: number | undefined): string | undefined {
  if (!tripStart || relativeDays === undefined) return undefined;
  const d = new Date(tripStart);
  d.setDate(d.getDate() + relativeDays);
  return d.toISOString();
}

async function generateTasks(days: ParsedDay[], model: string): Promise<CreateTaskRequest[]> {
  const input = JSON.stringify({
    days: days.map(d => ({
      dayNumber: d.dayNumber,
      date: d.date,
      type: d.type,
      regionName: d.regionName,
      country: d.country,
      accommodation: d.accommodation,
      vendors: d.vendors,
      species: d.species,
      transportNotes: d.transportNotes,
    })),
  });

  const result = await runPass("itinerary_tasks", input, model, 0.1);

  if (!Array.isArray(result)) {
    log.error("[ItineraryPlanner] Pass D returned non-array");
    return [];
  }

  const datesStart = days[0]?.date;

  return result.slice(0, 20).map((t: any, i: number): CreateTaskRequest => ({
    type: t.type || "custom",
    title: t.title || `Task ${i + 1}`,
    description: t.description,
    deadline: t.deadline || resolveDeadline(datesStart, t.relativeDays),
    sortOrder: t.sortOrder || i + 1,
    automationMode: t.automationMode || "remind",
    reminderSchedule: t.reminderSchedule,
    vendorName: t.vendorName,
  }));
}

/* ── Pass E: Meta (programmatic, no LLM) ── */

/* ── Vendor task coverage check (programmatic, no LLM) ── */

function ensureVendorTasks(days: ParsedDay[], tasks: CreateTaskRequest[]): CreateTaskRequest[] {
  // Collect all vendors from parsed days
  const vendorDayMap = new Map<string, ParsedDay>(); // lowercase vendor → first day
  for (const day of days) {
    for (const vendor of day.vendors) {
      const key = vendor.toLowerCase().trim();
      if (key && !vendorDayMap.has(key)) {
        vendorDayMap.set(key, day);
      }
    }
  }

  if (vendorDayMap.size === 0) return tasks;

  // Collect vendors already covered in tasks
  const coveredVendors = new Set<string>();
  for (const task of tasks) {
    if (task.vendorName) {
      coveredVendors.add(task.vendorName.toLowerCase().trim());
    }
  }

  // Find missing vendors
  const added: CreateTaskRequest[] = [];
  let sortOrder = tasks.length;

  for (const [vendorKey, day] of vendorDayMap) {
    if (coveredVendors.has(vendorKey)) continue;

    sortOrder++;
    const vendorName = day.vendors.find(v => v.toLowerCase().trim() === vendorKey) || vendorKey;
    const dateStr = day.date ? ` for ${day.date}` : "";

    // Deadline: 30 days before trip start
    let deadline: string | undefined;
    const tripStart = days[0]?.date;
    if (tripStart) {
      const d = new Date(tripStart);
      d.setDate(d.getDate() - 30);
      deadline = d.toISOString();
    }

    added.push({
      type: "booking",
      title: `Confirm booking with ${vendorName}`,
      description: `Confirm booking with ${vendorName}${dateStr} (Day ${day.dayNumber}).`,
      deadline,
      sortOrder,
      automationMode: "remind",
      vendorName,
    });
  }

  if (added.length > 0) {
    log.info({ added: added.map(t => t.vendorName) }, "[ItineraryPlanner] Added missing vendor tasks");
  }

  return [...tasks, ...added];
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function buildTitle(species: string[], regions: string[]): string {
  const topRegions = regions.slice(0, 2).join(" & ");
  if (species.length > 0) {
    const topSpecies = species.slice(0, 2).map(s => capitalize(s)).join(" & ");
    return `${topSpecies} Fishing — ${topRegions}`;
  }
  return topRegions;
}

function buildProjectMeta(days: ParsedDay[], locations: CreateLocationRequest[]): ProjectMeta {
  const datesStart = days[0]?.date || "";
  const datesEnd = days[days.length - 1]?.date || "";

  // Unique regions in order of appearance
  const regions = [...new Set(days.map(d => d.regionName).filter(Boolean))];
  const region = regions.join(", ");

  // Country — first mentioned
  const country = days[0]?.country || "";

  // All species, unique
  const targetSpecies = [...new Set(days.flatMap(d => d.species))];

  // Trip type
  const fishingDays = days.filter(d => d.type === "fishing").length;
  const tripType = fishingDays / days.length > 0.4 ? "fishing" : "mixed";

  // Title
  const title = buildTitle(targetSpecies, regions);

  // Center coordinates — average of all locations
  let latitude: number | undefined;
  let longitude: number | undefined;
  const validLocs = locations.filter(l => l.latitude && l.longitude);
  if (validLocs.length > 0) {
    latitude = validLocs.reduce((s, l) => s + l.latitude, 0) / validLocs.length;
    longitude = validLocs.reduce((s, l) => s + l.longitude, 0) / validLocs.length;
  }

  return { title, region, country, datesStart, datesEnd, targetSpecies, tripType, latitude, longitude };
}

/* ── Main ── */

export const itineraryPlannerService = {
  async generatePlan(request: { rawItinerary: string }): Promise<GeneratedPlan> {
    const startTime = Date.now();

    // Load model config
    const modelConfig = await getModel("trip_planner");
    const { model } = modelConfig;

    log.info({ model }, "[ItineraryPlanner] Starting 6-pass pipeline");

    // Pass A: parse
    const parsedDays = await parseItinerary(request.rawItinerary, model);
    const daysWithDates = fillMissingDates(parsedDays);
    log.info({ days: daysWithDates.length, hasAnchor: daysWithDates.some(d => !!d.date) }, "[ItineraryPlanner] Pass A (parse) complete");

    // Pass B: enrich (parallel)
    const enrichedDays = await Promise.all(daysWithDates.map(d => enrichDay(d, model)));
    log.info({ days: enrichedDays.length }, "[ItineraryPlanner] Pass B (enrich) complete");

    // Pass C + D: parallel
    const [locations, rawTasks] = await Promise.all([
      extractLocations(daysWithDates, model),
      generateTasks(daysWithDates, model),
    ]);
    log.info({ locations: locations.length, tasks: rawTasks.length }, "[ItineraryPlanner] Pass C+D (locations+tasks) complete");

    // Vendor coverage check (programmatic)
    const tasks = ensureVendorTasks(daysWithDates, rawTasks);

    // Pass E: meta (programmatic)
    const meta = buildProjectMeta(daysWithDates, locations);
    log.info({ title: meta.title, region: meta.region, tripType: meta.tripType }, "[ItineraryPlanner] Pass E (meta) complete");

    // Pass F: images
    let images: TripImages;
    try {
      images = await getItineraryImages(daysWithDates);
    } catch (err) {
      log.warn({ err }, "[ItineraryPlanner] Pass F (images) failed — using empty set");
      images = {
        cover: null,
        bands: [null, null, null],
        dayPhotos: [],
        fishPhotos: [],
        footer: null,
        actionBand: null,
        gearBand: null,
        seasonBand: null,
      };
    }

    const elapsed = Date.now() - startTime;
    log.info({ elapsed, days: enrichedDays.length, tasks: tasks.length, locations: locations.length }, "[ItineraryPlanner] Pipeline complete");

    // Format output — matches GeneratedPlan (Partial<CreateTripRequest>)
    return {
      project: {
        title: meta.title,
        region: meta.region,
        country: meta.country,
        latitude: meta.latitude,
        longitude: meta.longitude,
        datesStart: meta.datesStart,
        datesEnd: meta.datesEnd,
        targetSpecies: meta.targetSpecies,
        tripType: meta.tripType,
        coverImageUrl: images.cover?.url || undefined,
        itinerary: enrichedDays,
        images,
      },
      tasks,
      locations,
    };
  },
};
