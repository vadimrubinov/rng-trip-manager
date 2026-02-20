import OpenAI from "openai";
import { ENV } from "../config/env";

const client = new OpenAI({ apiKey: ENV.OPENAI_API_KEY });

export async function generateText(systemPrompt: string, userMessage: string): Promise<string> {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: "gpt-4o",
        temperature: 0.3,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      });
      return response.choices[0]?.message?.content || "";
    } catch (err: any) {
      console.error(`[OpenAI] Attempt ${attempt}/${MAX_RETRIES} failed:`, err?.message);
      if (attempt === MAX_RETRIES) throw err;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error("OpenAI: all retries failed");
}
