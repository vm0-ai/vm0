import { optionalEnv } from "../../lib/env";
import { settle } from "../utils";

const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";

interface OpenRouterMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

interface OpenRouterResponse {
  readonly choices: readonly {
    readonly message: {
      readonly content: string;
    };
  }[];
}

/**
 * Whether OpenRouter-backed text generation is available. Callers gate optional
 * LLM enrichment on this so the surrounding feature degrades when the key is
 * unset (e.g. local dev) instead of throwing.
 */
export function isLlmConfigured(): boolean {
  return Boolean(optionalEnv("OPENROUTER_API_KEY"));
}

/**
 * Call OpenRouter chat completions and return the trimmed first-choice text.
 * Returns `null` when no API key is configured. HTTP/parse failures throw so
 * the caller can decide how to degrade (typically by wrapping in `settle`).
 */
export async function generateText(
  model: string,
  messages: readonly OpenRouterMessage[],
  maxTokens: number,
): Promise<string | null> {
  const apiKey = optionalEnv("OPENROUTER_API_KEY");
  if (!apiKey) {
    return null;
  }

  const response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const settled = await settle(response.text());
    const text = settled.ok ? settled.value : "unknown error";
    throw new Error(`OpenRouter request failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as OpenRouterResponse;
  const content = data.choices[0]?.message.content.trim();
  if (!content) {
    throw new Error("OpenRouter returned empty content");
  }
  return content;
}
