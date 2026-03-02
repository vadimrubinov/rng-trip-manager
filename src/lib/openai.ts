import { log } from "../lib/pino-logger";
import OpenAI from "openai";
import { ENV } from "../config/env";
import { withRetry } from "./retry";

const client = new OpenAI({ apiKey: ENV.OPENAI_API_KEY, timeout: 60000 });

export { client as openaiClient };

export async function generateText(
  systemPrompt: string,
  userMessage: string,
  model: string = "gpt-4o",
  temperature: number = 0.3,
): Promise<string> {
  return withRetry(
    async () => {
      const response = await client.chat.completions.create({
        model,
        temperature,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      });
      return response.choices[0]?.message?.content || "";
    },
    { operationName: "openai.generateText" }
  );
}
