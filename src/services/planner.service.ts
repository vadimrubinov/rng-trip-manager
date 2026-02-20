import { airtable } from "../lib/airtable";
import { generateText } from "../lib/openai";
import { GeneratedPlan, GeneratePlanRequest, CreateTaskRequest, CreateLocationRequest } from "../types";

const FALLBACK_PROMPT = `You are a Trip Planner for BiteScout, a trophy fishing platform.

Task: extract a structured trip plan from a conversation summary (scout brief) or user-provided trip details. Generate a project structure with itinerary, tasks, and map locations.

Return ONLY valid JSON:

{"project":{"title":"string","description":"2-3 paragraph compelling description of the trip for a landing page","region":"string","country":"string","datesStart":"YYYY-MM-DD or null","datesEnd":"YYYY-MM-DD or null","targetSpecies":["string"],"tripType":"lodge-based|float-trip|expedition|charter","budgetMin":null,"budgetMax":null,"participantsCount":1,"experienceLevel":"beginner|intermediate|advanced|mixed","latitude":number,"longitude":number},"itinerary":[{"dayNumber":1,"title":"Day 1: Arrival","description":"Detailed description of what happens this day","highlights":["string"]}],"locations":[{"name":"string","type":"lodge|river|lake|ocean|airport|city|port|other","latitude":number,"longitude":number,"dayNumber":1,"sortOrder":1,"notes":"Brief description"}],"tasks":[{"type":"booking|payment|document|gear|travel|decision|communication","title":"string","description":"string","relativeDays":-30,"sortOrder":1,"automationMode":"remind|upsell","reminderSchedule":"7d,3d,1d","vendorName":null}]}

Rules:
1. relativeDays = days before trip start (negative). -30 = 30 days before.
2. Include tasks: documents (license,permits,visa,insurance), bookings (lodge/guide/charter,flights,transfers), gear (rod/reel,tackle,clothing), travel, payments (deposits,final), decisions.
3. automationMode: remind for personal actions, upsell for services we could do for a fee.
4. Order tasks by deadline. Max 25 tasks. Be specific to region and species.
5. Extract ALL vendors/lodges/guides mentioned in the brief.
6. If dates not set, use reasonable relative deadlines anyway.
7. description: write a compelling 2-3 paragraph narrative about the trip.
8. itinerary: day-by-day program of the trip itself (not preparation). Include arrival, fishing days, rest days, departure.
9. locations: real coordinates for all key places (lodge, fishing spots, airports, cities). Use accurate lat/lng.
10. latitude/longitude in project: center point for the map view.`;

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

    let prompt = await airtable.getPrompt("trip_planner");
    if (!prompt) {
      console.log("[Planner] Using fallback prompt (Airtable unavailable)");
      prompt = FALLBACK_PROMPT;
    }

    const text = await generateText(prompt, context);

    let parsed: any;
    try {
      parsed = JSON.parse(text.replace(/```json\n?|```\n?/g, "").trim());
    } catch {
      console.error("[Planner] Invalid JSON:", text.slice(0, 500));
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
