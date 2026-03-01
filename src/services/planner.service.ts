import { log } from "../lib/pino-logger";
import { airtable } from "../lib/airtable";
import { generateText } from "../lib/openai";
import { GeneratedPlan, GeneratePlanRequest, CreateTaskRequest, CreateLocationRequest } from "../types";

function resolveDeadline(tripStart: string | undefined, relativeDays: number | undefined): string | undefined {
  if (!tripStart || relativeDays === undefined) return undefined;
  const d = new Date(tripStart);
  d.setDate(d.getDate() + relativeDays);
  return d.toISOString();
}

export const plannerService = {
  async generatePlan(request: GeneratePlanRequest): Promise<GeneratedPlan> {
    let context = "";

    if (request.scoutId) {
      const scout = await airtable.getScout(request.scoutId);
      if (scout?.brief) context = `Scout Brief:\n${scout.brief}`;
      if (scout?.transcript) context += `\n\nTranscript:\n${scout.transcript}`;
    }

    if (request.tripDetails) {
      context += `\n\nUser details:\n${JSON.stringify(request.tripDetails, null, 2)}`;
    }

    if (!context.trim()) throw new Error("scoutId with brief or tripDetails required");

    const prompt = await airtable.getPrompt("trip_planner");
    if (!prompt) {
      throw new Error("Trip planner prompt unavailable — Airtable may be down");
    }

    const text = await generateText(prompt, context);

    let parsed: any;
    try {
      parsed = JSON.parse(text.replace(/```json\n?|```\n?/g, "").trim());
    } catch {
      log.error({ preview: text.slice(0, 500) }, "[Planner] Invalid JSON");
      throw new Error("Trip Planner returned invalid JSON");
    }

    return {
      project: {
        title: parsed.project?.title || "Untitled Trip",
        description: parsed.project?.description,
        region: parsed.project?.region,
        country: parsed.project?.country,
        latitude: parsed.project?.latitude,
        longitude: parsed.project?.longitude,
        datesStart: parsed.project?.datesStart,
        datesEnd: parsed.project?.datesEnd,
        targetSpecies: parsed.project?.targetSpecies,
        tripType: parsed.project?.tripType,
        budgetMin: parsed.project?.budgetMin,
        budgetMax: parsed.project?.budgetMax,
        participantsCount: parsed.project?.participantsCount,
        experienceLevel: parsed.project?.experienceLevel,
        itinerary: parsed.itinerary || [],
      },
      tasks: (parsed.tasks || []).slice(0, 25).map((t: any, i: number): CreateTaskRequest => ({
        type: t.type || "custom",
        title: t.title || `Task ${i + 1}`,
        description: t.description,
        deadline: resolveDeadline(parsed.project?.datesStart, t.relativeDays),
        sortOrder: t.sortOrder || i + 1,
        automationMode: t.automationMode || "remind",
        reminderSchedule: t.reminderSchedule,
        vendorName: t.vendorName,
      })),
      locations: (parsed.locations || []).map((loc: any, i: number): CreateLocationRequest => ({
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
