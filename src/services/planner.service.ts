import { log } from "../lib/pino-logger";
import { airtable, getModel } from "../lib/airtable";
import { generateText } from "../lib/openai";
import { GeneratedPlan, GeneratePlanRequest, CreateTaskRequest, CreateLocationRequest } from "../types";
import { getTripImages } from "./image.service";
import { withRetry } from "../lib/retry";

/* ── Helpers ── */

function resolveDeadline(tripStart: string | undefined, relativeDays: number | undefined): string | undefined {
  if (!tripStart || relativeDays === undefined) return undefined;
  const d = new Date(tripStart);
  d.setDate(d.getDate() + relativeDays);
  return d.toISOString();
}

function buildContext(request: GeneratePlanRequest): string {
  let context = "";

  if (request.rawItinerary) {
    const trimmed = request.rawItinerary.slice(0, 12000);
    context += `MODE: FOLLOW\n\nUser's day-by-day itinerary (follow this EXACTLY):\n${trimmed}`;
  }

  if (request.tripDetails) {
    context += `\n\nUser details:\n${JSON.stringify(request.tripDetails, null, 2)}`;
  }

  return context.trim();
}

async function runPass(promptKey: string, userMessage: string, model: string, temperature: number): Promise<any> {
  const prompt = await airtable.getPrompt(promptKey);
  if (!prompt) throw new Error(`Prompt "${promptKey}" not found or inactive`);

  const text = await withRetry(
    async () => generateText(prompt, userMessage, model, temperature),
    { operationName: `planner.${promptKey}`, maxAttempts: 2 },
  );

  try {
    return JSON.parse(text.replace(/```json\n?|```\n?/g, "").trim());
  } catch {
    log.error({ promptKey, preview: text.slice(0, 500) }, "[Planner] Invalid JSON from pass");
    throw new Error(`Pass "${promptKey}" returned invalid JSON`);
  }
}

/* ── Validation correction merger ── */

function applyCorrections(
  meta: any,
  itinerary: any[],
  tasks: any[],
  locations: any[],
  validation: any,
): { meta: any; itinerary: any[]; tasks: any[]; locations: any[] } {
  const corr = validation?.corrections;
  if (!corr || Object.keys(corr).length === 0) {
    return { meta, itinerary, tasks, locations };
  }

  // Project corrections
  if (corr.project) {
    Object.assign(meta, corr.project);
    log.info({ fields: Object.keys(corr.project) }, "[Planner] Applied project corrections");
  }

  // Itinerary corrections
  if (Array.isArray(corr.itinerary)) {
    for (const fix of corr.itinerary) {
      const idx = itinerary.findIndex((d: any) => d.dayNumber === fix.dayNumber);
      if (idx >= 0) {
        const { dayNumber, ...fields } = fix;
        Object.assign(itinerary[idx], fields);
      }
    }
    log.info({ count: corr.itinerary.length }, "[Planner] Applied itinerary corrections");
  }

  // Task corrections
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
    log.info("[Planner] Applied task corrections");
  }

  // Location corrections
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
    log.info("[Planner] Applied location corrections");
  }

  if (Array.isArray(validation.issues) && validation.issues.length > 0) {
    log.info({ issues: validation.issues }, "[Planner] Validation issues found and corrected");
  }

  return { meta, itinerary, tasks, locations };
}

/* ── Main ── */

export const plannerService = {
  async generatePlan(request: GeneratePlanRequest): Promise<GeneratedPlan> {
    // Build context from request
    let context = buildContext(request);

    if (request.scoutId) {
      const scout = await airtable.getScout(request.scoutId);
      if (scout?.brief) context = `Scout Brief:\n${scout.brief}\n\n${context}`;
      if (scout?.transcript) context += `\n\nTranscript:\n${scout.transcript}`;
    }

    if (!context.trim()) throw new Error("scoutId with brief or tripDetails required");

    // Load model config (same for all passes)
    const modelConfig = await getModel("trip_planner");
    const { model, temperature: temp } = modelConfig;
    const temperature = temp ?? 0.3;

    const startTime = Date.now();
    log.info({ model, hasScout: !!request.scoutId, hasRaw: !!request.rawItinerary }, "[Planner] Starting multi-pass generation");

    // ── Pass 1: Project Metadata ──
    const meta = await runPass("trip_plan_meta", context, model, temperature);
    log.info({ title: meta.title, region: meta.region, totalDays: meta.totalDays }, "[Planner] Pass 1 (meta) complete");

    // ── Pass 2: Itinerary ──
    const itineraryInput = `${context}\n\nProject metadata (already determined):\n${JSON.stringify(meta, null, 2)}`;
    const itinerary = await runPass("trip_plan_itinerary", itineraryInput, model, temperature);
    log.info({ days: Array.isArray(itinerary) ? itinerary.length : 0 }, "[Planner] Pass 2 (itinerary) complete");

    // ── Pass 3 + 4: Tasks & Locations (parallel) ──
    const planContext = JSON.stringify({ project: meta, itinerary }, null, 2);
    const tasksInput = `${context}\n\nGenerated plan:\n${planContext}`;
    const locationsInput = `Project and itinerary:\n${planContext}`;

    const [tasks, locations] = await Promise.all([
      runPass("trip_plan_tasks", tasksInput, model, temperature),
      runPass("trip_plan_locations", locationsInput, model, temperature),
    ]);
    log.info(
      { tasks: Array.isArray(tasks) ? tasks.length : 0, locations: Array.isArray(locations) ? locations.length : 0 },
      "[Planner] Pass 3+4 (tasks+locations) complete",
    );

    // ── Pass 5: Validation ──
    const fullPlan = { project: meta, itinerary, tasks, locations };
    let finalMeta = meta;
    let finalItinerary = Array.isArray(itinerary) ? itinerary : [];
    let finalTasks = Array.isArray(tasks) ? tasks : [];
    let finalLocations = Array.isArray(locations) ? locations : [];

    try {
      const validation = await runPass("trip_plan_validate", JSON.stringify(fullPlan, null, 2), model, Math.min(temperature, 0.1));
      const corrected = applyCorrections(finalMeta, finalItinerary, finalTasks, finalLocations, validation);
      finalMeta = corrected.meta;
      finalItinerary = corrected.itinerary;
      finalTasks = corrected.tasks;
      finalLocations = corrected.locations;
      log.info("[Planner] Pass 5 (validation) complete");
    } catch (err) {
      log.warn({ err }, "[Planner] Validation pass failed — using unvalidated plan");
    }

    const elapsed = Date.now() - startTime;
    log.info({ elapsed, days: finalItinerary.length, tasks: finalTasks.length, locations: finalLocations.length }, "[Planner] Multi-pass generation complete");

    // ── Fetch images ──
    const images = await getTripImages(
      finalMeta.region,
      finalMeta.targetSpecies,
      finalMeta.tripType,
      finalMeta.country,
      finalItinerary.length,
    );

    // ── Format output ──
    return {
      project: {
        title: finalMeta.title || "Untitled Trip",
        description: finalMeta.description,
        coverImageUrl: images.cover?.url || undefined,
        region: finalMeta.region,
        country: finalMeta.country,
        latitude: finalMeta.latitude,
        longitude: finalMeta.longitude,
        datesStart: finalMeta.datesStart,
        datesEnd: finalMeta.datesEnd,
        targetSpecies: finalMeta.targetSpecies,
        tripType: finalMeta.tripType,
        budgetMin: finalMeta.budgetMin,
        budgetMax: finalMeta.budgetMax,
        participantsCount: finalMeta.participantsCount,
        experienceLevel: finalMeta.experienceLevel,
        itinerary: finalItinerary.map((d: any) => ({
          dayNumber: d.dayNumber,
          title: d.title || `Day ${d.dayNumber}`,
          description: d.description || "",
          type: d.type,
          activities: d.activities || d.highlights || [],
          highlights: d.activities || d.highlights || [],
          accommodation: d.accommodation || null,
        })),
        images,
      },
      tasks: finalTasks.slice(0, 30).map((t: any, i: number): CreateTaskRequest => ({
        type: t.type || "custom",
        title: t.title || `Task ${i + 1}`,
        description: t.description,
        deadline: resolveDeadline(finalMeta.datesStart, t.relativeDays),
        sortOrder: t.sortOrder || i + 1,
        automationMode: t.automationMode || "remind",
        reminderSchedule: t.reminderSchedule,
        vendorName: t.vendorName,
      })),
      locations: finalLocations.map((loc: any, i: number): CreateLocationRequest => ({
        name: loc.name || `Location ${i + 1}`,
        type: loc.type || "other",
        latitude: loc.latitude || 0,
        longitude: loc.longitude || 0,
        dayNumber: loc.dayNumber,
        sortOrder: loc.sortOrder || i + 1,
        notes: loc.notes,
      })),
    };
  },
};
