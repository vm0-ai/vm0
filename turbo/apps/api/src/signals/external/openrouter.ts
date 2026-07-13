import { optionalEnv } from "../../lib/env";
import { settle } from "../utils";

const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterTextPart {
  readonly type: "text";
  readonly text: string;
}

export interface OpenRouterImagePart {
  readonly type: "image_url";
  readonly image_url: { readonly url: string };
}

export type OpenRouterContentPart = OpenRouterTextPart | OpenRouterImagePart;

interface OpenRouterMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string | readonly OpenRouterContentPart[];
}

export interface OpenRouterTokenDetails {
  readonly cached_tokens?: number;
  readonly cache_write_tokens?: number;
  readonly reasoning_tokens?: number;
}

export interface OpenRouterUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly prompt_tokens_details?: OpenRouterTokenDetails;
  readonly completion_tokens_details?: OpenRouterTokenDetails;
}

interface OpenRouterTextGeneration {
  readonly text: string;
  readonly usage?: OpenRouterUsage;
}

interface OpenRouterResponse {
  readonly usage?: OpenRouterUsage;
  readonly choices: readonly {
    readonly finish_reason: string | null;
    readonly native_finish_reason?: string | null;
    readonly message: {
      readonly content: string;
    };
  }[];
}

interface OpenRouterGenerateTextOptions {
  readonly signal?: AbortSignal;
  readonly responseFormat?: { readonly type: "json_object" };
  readonly temperature?: number;
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
  maxTokens?: number,
  options?: OpenRouterGenerateTextOptions,
): Promise<string | null> {
  const generation = await generateTextWithUsage(
    model,
    messages,
    maxTokens,
    options,
  );
  return generation?.text ?? null;
}

/**
 * Call OpenRouter chat completions and return both text and provider-reported
 * usage. The usage payload is intentionally passed through with OpenRouter's
 * snake_case fields so billing code can stay aligned with their API surface.
 */
export async function generateTextWithUsage(
  model: string,
  messages: readonly OpenRouterMessage[],
  maxTokens?: number,
  options?: OpenRouterGenerateTextOptions,
): Promise<OpenRouterTextGeneration | null> {
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
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
      ...(options?.responseFormat === undefined
        ? {}
        : { response_format: options.responseFormat }),
      temperature: options?.temperature ?? 0.3,
    }),
    signal: options?.signal,
  });

  if (!response.ok) {
    const settled = await settle(response.text());
    const text = settled.ok ? settled.value : "unknown error";
    throw new Error(`OpenRouter request failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as OpenRouterResponse;
  const choice = data.choices[0];
  if (!choice) {
    throw new Error("OpenRouter returned no choices");
  }
  if (choice.finish_reason !== "stop") {
    const nativeReason = choice.native_finish_reason
      ? ` (native: ${choice.native_finish_reason})`
      : "";
    throw new Error(
      `OpenRouter completion finished with ${choice.finish_reason ?? "unknown"}${nativeReason}`,
    );
  }

  const content = choice.message.content.trim();
  if (!content) {
    throw new Error("OpenRouter returned empty content");
  }
  return data.usage === undefined
    ? { text: content }
    : { text: content, usage: data.usage };
}
