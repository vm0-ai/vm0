import { optionalEnv } from "../../lib/env";
import { readBoundedResponseText, safeJsonParse } from "../utils";

const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_ERROR_RESPONSE_MAX_BYTES = 64 * 1024;

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

interface OpenRouterChoice {
  readonly finish_reason: string | null;
  readonly native_finish_reason?: string | null;
  readonly error?: unknown;
  readonly message?: {
    readonly content?: unknown;
  };
}

interface OpenRouterResponse {
  readonly usage?: OpenRouterUsage;
  readonly error?: unknown;
  readonly choices?: readonly OpenRouterChoice[];
}

interface OpenRouterGenerateTextOptions {
  readonly signal?: AbortSignal;
  readonly responseFormat?: { readonly type: "json_object" };
  readonly temperature?: number;
}

export class OpenRouterRequestError extends Error {
  readonly status: number;
  readonly errorType: string | undefined;

  constructor(args: {
    readonly message: string;
    readonly status: number;
    readonly errorType?: string;
  }) {
    const errorType = args.errorType ? ` (${args.errorType})` : "";
    super(`${args.message}: ${String(args.status)}${errorType}`);
    this.name = "OpenRouterRequestError";
    this.status = args.status;
    this.errorType = args.errorType;
  }
}

function objectProperty(value: unknown, property: string): unknown | undefined {
  if (typeof value !== "object" || value === null || !(property in value)) {
    return undefined;
  }
  return value[property as keyof typeof value];
}

function openRouterErrorType(value: unknown): string | undefined {
  const error = objectProperty(value, "error") ?? value;
  const metadata = objectProperty(error, "metadata");
  const errorType = objectProperty(metadata, "error_type");
  return typeof errorType === "string" &&
    /^[a-z][a-z0-9_]{0,127}$/u.test(errorType)
    ? errorType
    : undefined;
}

function openRouterRequestError(args: {
  readonly message: string;
  readonly status: number;
  readonly value: unknown;
}): OpenRouterRequestError {
  const errorType = openRouterErrorType(args.value);
  return new OpenRouterRequestError({
    message: args.message,
    status: args.status,
    ...(errorType === undefined ? {} : { errorType }),
  });
}

async function ensureOpenRouterResponseOk(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }
  const errorBody = await readBoundedResponseText(
    response,
    OPENROUTER_ERROR_RESPONSE_MAX_BYTES,
  );
  const errorValue =
    errorBody.kind === "text" ? safeJsonParse(errorBody.text) : undefined;
  throw openRouterRequestError({
    message: "OpenRouter request failed",
    status: response.status,
    value: errorValue,
  });
}

function parseOpenRouterGeneration(
  data: OpenRouterResponse,
): OpenRouterTextGeneration {
  const choice = data.choices?.[0];
  if (!choice) {
    if (data.error !== undefined) {
      throw openRouterRequestError({
        message: "OpenRouter request failed",
        status: 502,
        value: data,
      });
    }
    throw new Error("OpenRouter returned no choices");
  }
  if (choice.finish_reason === "error") {
    throw openRouterRequestError({
      message: "OpenRouter completion failed",
      status: 502,
      value: choice.error ?? data.error,
    });
  }
  if (choice.finish_reason !== "stop") {
    const nativeReason = choice.native_finish_reason
      ? ` (native: ${choice.native_finish_reason})`
      : "";
    throw new Error(
      `OpenRouter completion finished with ${choice.finish_reason ?? "unknown"}${nativeReason}`,
    );
  }

  const rawContent = choice.message?.content;
  if (typeof rawContent !== "string") {
    throw new Error("OpenRouter returned invalid content");
  }
  const content = rawContent.trim();
  if (!content) {
    throw new Error("OpenRouter returned empty content");
  }
  return data.usage === undefined
    ? { text: content }
    : { text: content, usage: data.usage };
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
  await ensureOpenRouterResponseOk(response);
  const data = (await response.json()) as OpenRouterResponse;
  return parseOpenRouterGeneration(data);
}
