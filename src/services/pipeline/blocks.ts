/**
 * Unified Trip Generation Pipeline — Block Generators
 * Each function generates one block of the trip landing page.
 */

import { log } from "../../lib/pino-logger";
import { airtable, getModel, ModelConfig } from "../../lib/airtable";
import { generateText } from "../../lib/openai";
import { withRetry } from "../../lib/retry";
import { ItineraryDay, CreateTaskRequest, CreateLocationRequest, GearList } from "../../types";
import {
  TripContext,
  HeroData,
  SeasonData,
  BudgetBreakdown,
  ImageSet,
  GearData,
} from "./types";
import {
  fillMissingDates,
  ensureVendorTasks,
  extractClientTitle,
  mapDayType,
  resolveDeadline,
} from "./strategies";

/* ── LLM helper (same pattern as planner.service) ── */

async function runPass(promptKey: string, userMessage: string, model: string, temperature: number): Promise<any> {
  const prompt = await airtable.getPrompt(promptKey);
  if (!prompt) throw new Error(`Prompt "${promptKey}" not found or inactive`);

  const text = await withRetry(
    async () => generateText(prompt, userMessage, model, temperature),
    { operationName: `pipeline.${promptKey}`, maxAttempts: 2 },
  );

  try {
    return JSON.parse(text.replace(/```json\n?|```\n?/g, "").trim());
  } catch {
    log.error({ promptKey, preview: text.slice(0, 500) }, "[Pipeline] Invalid JSON from pass");
    throw new Error(`Pass "${promptKey}" returned invalid JSON`);
  }
}

async function runPassText(promptKey: string, userMessage: string, model: string, temperature: number): Promise<string> {
  const prompt = await airtable.getPrompt(promptKey);
  if (!prompt) throw new Error(`Prompt "${promptKey}" not found or inactive`);

  return withRetry(
    async () => generateText(prompt, userMessage, model, temperature),
    { operationName: `pipeline.${promptKey}`, maxAttempts: 2 },
  );
}

/* ── Context builder ── */

function buildContextString(context: TripContext): string {
  let ctx = "";
  if (context.scoutBrief) ctx += `Scout Brief:\n${context.scoutBrief}\n\n`;
  if (context.transcript) ctx += `Transcript:\n${context.transcript}\n\n`;
  if (context.rawItinerary) ctx += `Raw Itinerary:\n${context.rawItinerary.slice(0, 12000)}\n\n`;
  if (context.tripDetails) ctx += `Trip Details:\n${JSON.stringify(context.tripDetails, null, 2)}\n\n`;
  return ctx.trim();
}

/* ── BLOCK: HERO ── */

export async function generateHero(context: TripContext, model: string): Promise<HeroData> {
  const input = buildContextString(context);
  const hero = await runPass("pipeline_hero", input, model, 0.3);

  // Path 2: preserve client title if provided
  if (context.source === "raw_itinerary" && context.clientTitle) {
    hero.title = context.clientTitle;
  }

  return {
    title: hero.title || "Untitled Trip",
    region: hero.region || "",
    country: hero.country || "",
    latitude: hero.latitude || 0,
    longitude: hero.longitude || 0,
    datesStart: hero.datesStart || "",
    datesEnd: hero.datesEnd || "",
    targetSpecies: Array.isArray(hero.targetSpecies) ? hero.targetSpecies : [],
    tripType: hero.tripType || "fishing",
    experienceLevel: hero.experienceLevel || "intermediate",
    participantsCount: hero.participantsCount || 2,
    budgetEstimate: hero.budgetEstimate,
  };
}

/* ── BLOCK: DAYS ── */

export async function generateDays(context: TripContext, model: string): Promise<ItineraryDay[]> {
  switch (context.source) {
    case "scout":
    case "manual": {
      const input = buildContextString(context);
      const days = await runPass("pipeline_days_generate", input, model, 0.3);
      if (!Array.isArray(days)) throw new Error("pipeline_days_generate did not return an array");
      return days.map((d: any, i: number) => ({
        dayNumber: d.dayNumber ?? i + 1,
        title: d.title || `Day ${d.dayNumber ?? i + 1}`,
        description: d.description || "",
        type: d.type || "offshore",
        activities: d.activities || d.highlights || [],
        highlights: d.activities || d.highlights || [],
        accommodation: d.accommodation || null,
      }));
    }

    case "raw_itinerary": {
      // Pass A: Parse
      const trimmed = (context.rawItinerary || "").slice(0, 12000);
      const parsed = await runPass("itinerary_parse", trimmed, model, 0);
      if (!Array.isArray(parsed)) throw new Error("itinerary_parse did not return an array");

      const normalizedDays = parsed.map((d: any, i: number) => ({
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

      // Fill dates programmatically
      const withDates = fillMissingDates(normalizedDays);

      // Pass B: Enrich each day (parallel)
      const enrichedDays = await Promise.all(
        withDates.map(async (d) => {
          const enriched = await runPass("itinerary_enrich_day", JSON.stringify(d), model, 0.1);
          return {
            dayNumber: enriched.dayNumber ?? d.dayNumber,
            title: enriched.title || d.title,
            description: enriched.description || d.description,
            type: enriched.type || mapDayType(d.type),
            activities: Array.isArray(enriched.activities) ? enriched.activities : [],
            highlights: Array.isArray(enriched.highlights) ? enriched.highlights : [],
            accommodation: enriched.accommodation || (d.accommodation ? { name: d.accommodation } : null),
          } as ItineraryDay;
        })
      );

      return enrichedDays;
    }

    case "template":
      throw new Error("Template source not implemented");

    default:
      throw new Error(`Unknown source: ${context.source}`);
  }
}

/* ── BLOCK: OVERVIEW (writes to description column) ── */

export async function generateOverview(
  context: TripContext,
  hero: HeroData,
  days: ItineraryDay[],
  model: string,
): Promise<string> {
  const input = JSON.stringify({ hero, daysCount: days.length, dayTitles: days.map(d => d.title) });
  const result = await runPassText("pipeline_overview", input, model, 0.5);
  // Return plain text (2-3 paragraphs)
  return result.replace(/```\n?/g, "").trim();
}

/* ── BLOCK: TASKS ── */

export async function generateTasks(
  context: TripContext,
  hero: HeroData,
  days: ItineraryDay[],
  model: string,
): Promise<CreateTaskRequest[]> {
  const input = JSON.stringify({
    hero,
    days: days.map(d => ({
      dayNumber: d.dayNumber,
      title: d.title,
      type: d.type,
      accommodation: d.accommodation,
    })),
    source: context.source,
  });

  const result = await runPass("pipeline_tasks", input, model, 0.2);
  if (!Array.isArray(result)) return [];

  const tasks = result.slice(0, 30).map((t: any, i: number): CreateTaskRequest => ({
    type: t.type || "custom",
    title: t.title || `Task ${i + 1}`,
    description: t.description,
    deadline: t.deadline || resolveDeadline(hero.datesStart, t.relativeDays),
    sortOrder: t.sortOrder || i + 1,
    automationMode: t.automationMode || "remind",
    reminderSchedule: t.reminderSchedule,
    vendorName: t.vendorName,
  }));

  return tasks;
}

/* ── BLOCK: LOCATIONS ── */

export async function generateLocations(
  days: ItineraryDay[],
  model: string,
): Promise<CreateLocationRequest[]> {
  const input = JSON.stringify(
    days.map(d => ({
      dayNumber: d.dayNumber,
      title: d.title,
      description: d.description,
      accommodation: d.accommodation,
    }))
  );

  const result = await runPass("pipeline_locations", input, model, 0.1);
  if (!Array.isArray(result)) return [];

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

/* ── BLOCK: GEAR ── */

export async function generateGear(
  hero: HeroData,
  model: string,
): Promise<GearData> {
  const input = JSON.stringify({
    region: hero.region,
    country: hero.country,
    targetSpecies: hero.targetSpecies,
    tripType: hero.tripType,
    datesStart: hero.datesStart,
    datesEnd: hero.datesEnd,
    experienceLevel: hero.experienceLevel,
  });

  const result = await runPass("pipeline_gear", input, model, 0.2);
  return {
    fishing: Array.isArray(result.fishing) ? result.fishing : [],
    clothing: Array.isArray(result.clothing) ? result.clothing : [],
    documents: Array.isArray(result.documents) ? result.documents : [],
    essentials: Array.isArray(result.essentials) ? result.essentials : [],
  };
}

/* ── BLOCK: SEASON (NEW) ── */

export async function generateSeason(
  hero: HeroData,
  model: string,
): Promise<SeasonData> {
  const input = JSON.stringify({
    region: hero.region,
    country: hero.country,
    targetSpecies: hero.targetSpecies,
    datesStart: hero.datesStart,
    datesEnd: hero.datesEnd,
  });

  const result = await runPass("pipeline_season", input, model, 0.2);
  return {
    summary: result.summary || "",
    airTemp: result.airTemp || { min: 0, max: 0, unit: "C" },
    waterTemp: result.waterTemp || { min: 0, max: 0, unit: "C" },
    rainfall: result.rainfall || "unknown",
    bestMonths: Array.isArray(result.bestMonths) ? result.bestMonths : [],
    speciesByMonth: result.speciesByMonth || {},
  };
}

/* ── BLOCK: BUDGET (NEW) ── */

export async function generateBudget(
  context: TripContext,
  hero: HeroData,
  days: ItineraryDay[],
  model: string,
): Promise<BudgetBreakdown> {
  const input = JSON.stringify({
    region: hero.region,
    country: hero.country,
    tripType: hero.tripType,
    daysCount: days.length,
    participantsCount: hero.participantsCount,
    budgetEstimate: hero.budgetEstimate,
    targetSpecies: hero.targetSpecies,
  });

  const result = await runPass("pipeline_budget", input, model, 0.2);
  return {
    categories: Array.isArray(result.categories) ? result.categories : [],
    totalEstimate: result.totalEstimate || 0,
    currency: result.currency || "USD",
    perPersonNote: result.perPersonNote || "",
  };
}

/* ── BLOCK: IMAGES (STUB) ── */

export async function generateImagesStub(
  hero: HeroData,
  days: ItineraryDay[],
): Promise<ImageSet> {
  return {
    cover: null,
    bands: [null, null, null],
    dayPhotos: days.map(() => null),
    fishPhotos: [],
    footer: null,
    actionBand: null,
    gearBand: null,
    seasonBand: null,
    _stub: true,
  };
}

/* ── BLOCK: VALIDATE ── */

export async function validatePlan(
  allBlocks: {
    hero: HeroData;
    days: ItineraryDay[];
    overview: string;
    tasks: CreateTaskRequest[];
    locations: CreateLocationRequest[];
    gear: GearData;
    season: SeasonData;
    budget: BudgetBreakdown;
  },
  model: string,
): Promise<any> {
  const input = JSON.stringify(allBlocks);
  try {
    return await runPass("pipeline_validate", input, model, 0.1);
  } catch (err) {
    log.warn({ err }, "[Pipeline] Validation pass failed — skipping corrections");
    return { corrections: {} };
  }
}

/* ── Apply corrections from validate ── */

export function applyCorrections(
  hero: HeroData,
  days: ItineraryDay[],
  tasks: CreateTaskRequest[],
  locations: CreateLocationRequest[],
  validation: any,
): { hero: HeroData; days: ItineraryDay[]; tasks: CreateTaskRequest[]; locations: CreateLocationRequest[] } {
  const corr = validation?.corrections;
  if (!corr || Object.keys(corr).length === 0) {
    return { hero, days, tasks, locations };
  }

  if (corr.project) {
    Object.assign(hero, corr.project);
    log.info({ fields: Object.keys(corr.project) }, "[Pipeline] Applied project corrections");
  }

  if (Array.isArray(corr.itinerary)) {
    for (const fix of corr.itinerary) {
      const idx = days.findIndex((d: any) => d.dayNumber === fix.dayNumber);
      if (idx >= 0) {
        const { dayNumber, ...fields } = fix;
        Object.assign(days[idx], fields);
      }
    }
    log.info({ count: corr.itinerary.length }, "[Pipeline] Applied itinerary corrections");
  }

  if (corr.tasks) {
    if (Array.isArray(corr.tasks.remove)) {
      const sorted = [...corr.tasks.remove].sort((a: number, b: number) => b - a);
      for (const idx of sorted) {
        if (idx >= 0 && idx < tasks.length) tasks.splice(idx, 1);
      }
    }
    if (Array.isArray(corr.tasks.fix)) {
      for (const fix of corr.tasks.fix) {
        if (fix.index >= 0 && fix.index < tasks.length) {
          const { index, ...fields } = fix;
          Object.assign(tasks[index], fields);
        }
      }
    }
  }

  if (corr.locations) {
    if (Array.isArray(corr.locations.add)) {
      locations.push(...corr.locations.add);
    }
    if (Array.isArray(corr.locations.fix)) {
      for (const fix of corr.locations.fix) {
        if (fix.index >= 0 && fix.index < locations.length) {
          const { index, ...fields } = fix;
          Object.assign(locations[index], fields);
        }
      }
    }
  }

  return { hero, days, tasks, locations };
}