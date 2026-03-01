import { log } from "../lib/pino-logger";
import { airtable } from "../lib/airtable";
import { openaiClient } from "../lib/openai";

interface InquiryContext {
  vendorName: string;
  tripTitle: string;
  region: string | null;
  country: string | null;
  datesStart: string | null;
  datesEnd: string | null;
  targetSpecies: string[] | null;
  tripType: string | null;
  participantsCount: number | null;
  experienceLevel: string | null;
  description: string | null;
  customMessage?: string;
}

interface GeneratedInquiry {
  subject: string;
  body: string;
}

export async function generateVendorInquiry(ctx: InquiryContext): Promise<GeneratedInquiry> {
  const prompt = await airtable.getPrompt("vendor_inquiry_generator");
  if (!prompt) {
    throw new Error("Prompt 'vendor_inquiry_generator' not found in Airtable");
  }

  const userContext = [
    `Vendor: ${ctx.vendorName}`,
    `Trip: ${ctx.tripTitle}`,
    ctx.region && `Region: ${ctx.region}`,
    ctx.country && `Country: ${ctx.country}`,
    ctx.datesStart && `Dates: ${ctx.datesStart}${ctx.datesEnd ? ` to ${ctx.datesEnd}` : ""}`,
    ctx.targetSpecies?.length && `Target species: ${ctx.targetSpecies.join(", ")}`,
    ctx.tripType && `Trip type: ${ctx.tripType}`,
    ctx.participantsCount && `Group size: ${ctx.participantsCount} people`,
    ctx.experienceLevel && `Experience level: ${ctx.experienceLevel}`,
    ctx.description && `Trip description: ${ctx.description}`,
    ctx.customMessage && `Additional notes from client: ${ctx.customMessage}`,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await openaiClient.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: userContext },
    ],
  });

  const text = response.choices[0]?.message?.content || "";

  // Parse JSON response
  let parsed: any;
  try {
    parsed = JSON.parse(text.replace(/```json\n?|```\n?/g, "").trim());
  } catch {
    log.error({ preview: text.slice(0, 300) }, "[VendorInquiry AI] Invalid JSON");
    // Fallback: use entire text as body
    return {
      subject: `Fishing charter inquiry — ${ctx.tripTitle}`,
      body: text,
    };
  }

  return {
    subject: parsed.subject || `Fishing charter inquiry — ${ctx.tripTitle}`,
    body: parsed.body || text,
  };
}

// --- Vendor Reply Classifier ---

const FALLBACK_CLASSIFIER_PROMPT = `You are a fishing charter inquiry classifier. Analyze the vendor's reply to a customer inquiry and classify it.

Input: The vendor's reply text and the original inquiry for context.

Output ONLY valid JSON (no markdown, no backticks):
{
  "classification": "confirmed" | "declined" | "need_info" | "pricing" | "other",
  "summary": "1-2 sentence summary of the vendor's response",
  "suggestedAction": "recommended next step for the customer"
}

Classification rules:
- "confirmed": Vendor confirms availability, provides booking details, says yes
- "declined": Vendor says they're fully booked, unavailable, or cannot accommodate
- "need_info": Vendor asks for more details (dates, group size, preferences)
- "pricing": Vendor provides pricing, quotes, or rate information
- "other": Auto-reply, out-of-office, unrelated, or unclear response`;

export interface ReplyClassification {
  classification: "confirmed" | "declined" | "need_info" | "pricing" | "other";
  summary: string;
  suggestedAction: string;
}

export async function classifyVendorReply(ctx: {
  replyText: string;
  originalSubject: string;
  originalBody: string;
  vendorName: string;
}): Promise<ReplyClassification> {
  const fallback: ReplyClassification = {
    classification: "other",
    summary: ctx.replyText.slice(0, 200),
    suggestedAction: "Review manually",
  };

  try {
    let systemPrompt = await airtable.getPrompt("vendor_reply_classifier");
    if (!systemPrompt) {
      log.warn("[VendorReply AI] Prompt not found in Airtable, using fallback");
      systemPrompt = FALLBACK_CLASSIFIER_PROMPT;
    }

    const userMessage = [
      `Vendor: ${ctx.vendorName}`,
      `Original inquiry subject: ${ctx.originalSubject}`,
      `Original inquiry body:\n${ctx.originalBody}`,
      `\nVendor's reply:\n${ctx.replyText}`,
    ].join("\n");

    const response = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    });

    const text = response.choices[0]?.message?.content || "";
    const parsed = JSON.parse(text.replace(/```json\n?|```\n?/g, "").trim());

    const validClassifications = ["confirmed", "declined", "need_info", "pricing", "other"];
    return {
      classification: validClassifications.includes(parsed.classification) ? parsed.classification : "other",
      summary: parsed.summary || ctx.replyText.slice(0, 200),
      suggestedAction: parsed.suggestedAction || "Review manually",
    };
  } catch (err: any) {
    log.error({ err }, "[VendorReply AI] Classification error");
    return fallback;
  }
}
