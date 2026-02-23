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
    console.error("[VendorInquiry AI] Invalid JSON:", text.slice(0, 300));
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
