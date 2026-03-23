import "server-only";
import { env } from "../../env";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "google/gemini-3.1-flash-lite-preview";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenRouterResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

/**
 * Generate text using a lightweight model via OpenRouter.
 *
 * This is an internal-only service for cheap NLP tasks like title generation.
 *
 * Returns null if OPENROUTER_API_KEY is not configured.
 * Throws on HTTP errors or empty responses — callers handle errors.
 */
async function generateText(messages: ChatMessage[]): Promise<string | null> {
  const { OPENROUTER_API_KEY, OPENROUTER_MODEL, OPENROUTER_BASE_URL } = env();

  if (!OPENROUTER_API_KEY) {
    return null;
  }

  const model = OPENROUTER_MODEL ?? DEFAULT_MODEL;
  const baseUrl = OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL;

  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 30,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown error");
    throw new Error(`OpenRouter request failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as OpenRouterResponse;
  const content = data.choices[0]?.message?.content;

  if (!content) {
    throw new Error("OpenRouter returned empty content");
  }

  return content.trim();
}

/**
 * Generate a short title for a chat thread from the user's first message.
 *
 * Returns null if the lightweight model is unavailable.
 */
export async function generateChatTitle(
  userMessage: string,
): Promise<string | null> {
  return generateText([
    {
      role: "system",
      content:
        "Generate a short, descriptive title (max 60 chars) for a chat conversation based on the user's first message. Return only the title, no quotes or extra text.",
    },
    { role: "user", content: userMessage },
  ]);
}
