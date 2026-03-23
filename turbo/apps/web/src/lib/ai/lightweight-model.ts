import "server-only";
import { env } from "../../env";
import { logger } from "../logger";

const log = logger("ai:lightweight-model");

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "google/gemini-3.1-flash-lite-preview";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface GenerateTextOptions {
  /** Override the default model */
  model?: string;
  /** Maximum tokens to generate (default: 256) */
  maxTokens?: number;
  /** Temperature (default: 0.3) */
  temperature?: number;
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
 * This is an internal-only service for cheap NLP tasks like
 * summary generation, title extraction, etc.
 *
 * Returns null if OPENROUTER_API_KEY is not configured.
 */
async function generateText(
  messages: ChatMessage[],
  options?: GenerateTextOptions,
): Promise<string | null> {
  const { OPENROUTER_API_KEY, OPENROUTER_MODEL } = env();

  if (!OPENROUTER_API_KEY) {
    log.warn(
      "OPENROUTER_API_KEY not configured, skipping lightweight model call",
    );
    return null;
  }

  const model = options?.model ?? OPENROUTER_MODEL ?? DEFAULT_MODEL;
  const maxTokens = options?.maxTokens ?? 256;
  const temperature = options?.temperature ?? 0.3;

  const response = await fetch(OPENROUTER_BASE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown error");
    log.error("OpenRouter request failed", {
      status: response.status,
      body: text,
    });
    return null;
  }

  const data = (await response.json()) as OpenRouterResponse;
  const content = data.choices[0]?.message?.content;

  if (!content) {
    log.warn("OpenRouter returned empty content");
    return null;
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
  return generateText(
    [
      {
        role: "system",
        content:
          "Generate a short, descriptive title (max 60 chars) for a chat conversation based on the user's first message. Return only the title, no quotes or extra text.",
      },
      { role: "user", content: userMessage },
    ],
    { maxTokens: 30, temperature: 0.3 },
  );
}
