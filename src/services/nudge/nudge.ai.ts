import { openaiClient } from "../../lib/openai";
import { airtable } from "../../lib/airtable";

interface NudgeMessageInput {
  triggerType: string;
  automationMode: string;
  tripTitle: string;
  tripRegion?: string;
  tripDates?: string;
  targetSpecies?: string;
  taskTitle?: string;
  taskType?: string;
  days?: number;
  participantName?: string;
  eventText?: string;
}

interface NudgeMessage {
  subject: string;
  body: string;
}

const FALLBACK_MESSAGES: Record<string, NudgeMessage> = {
  deadline: {
    subject: "Task reminder for your fishing trip",
    body: "You have an upcoming task deadline. Check your trip plan for details.",
  },
  countdown: {
    subject: "Your fishing trip is coming up!",
    body: "Your trip is approaching. Make sure everything is ready!",
  },
  overdue: {
    subject: "Overdue task on your fishing trip",
    body: "You have an overdue task. Please take action soon.",
  },
  event: {
    subject: "Update on your fishing trip",
    body: "There's a new update on your trip. Check the details.",
  },
};

export async function generateNudgeMessage(input: NudgeMessageInput): Promise<NudgeMessage> {
  try {
    const promptText = await airtable.getPrompt("nudge_generator");
    if (!promptText) {
      console.warn("[NudgeAI] Prompt not found, using fallback");
      return getFallback(input.triggerType);
    }

    const userMessage = Object.entries({
      trigger_type: input.triggerType,
      automation_mode: input.automationMode,
      trip_title: input.tripTitle,
      trip_region: input.tripRegion || "",
      trip_dates: input.tripDates || "",
      target_species: input.targetSpecies || "",
      task_title: input.taskTitle || "",
      task_type: input.taskType || "",
      days: input.days !== undefined ? String(input.days) : "",
      participant_name: input.participantName || "",
      event_text: input.eventText || "",
    })
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");

    const response = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      max_tokens: 200,
      messages: [
        { role: "system", content: promptText },
        { role: "user", content: userMessage },
      ],
    });

    const raw = response.choices[0]?.message?.content || "";
    return parseAIResponse(raw, input.triggerType);
  } catch (err: any) {
    console.error("[NudgeAI] Generation failed:", err?.message);
    return getFallback(input.triggerType);
  }
}

function parseAIResponse(raw: string, triggerType: string): NudgeMessage {
  try {
    // Strip markdown code fences if present
    const cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (parsed.subject && parsed.body) {
      return { subject: String(parsed.subject).slice(0, 300), body: String(parsed.body).slice(0, 1000) };
    }
  } catch {}
  console.warn("[NudgeAI] Failed to parse AI response, using fallback");
  return getFallback(triggerType);
}

function getFallback(triggerType: string): NudgeMessage {
  return FALLBACK_MESSAGES[triggerType] || FALLBACK_MESSAGES.event;
}
