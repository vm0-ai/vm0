import { optionalEnv } from "../../lib/env";
import {
  onRejection,
  readBoundedResponseText,
  safeJsonParse,
  safeSync,
} from "../utils";
import {
  recordOpenRouterFailure,
  recordOpenRouterRequestFailure,
  recordOpenRouterTransportFailure,
} from "./openrouter-failure";

const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_ERROR_RESPONSE_MAX_BYTES = 64 * 1024;

/**
 * The model behind every internal fast-path generation: chat and shared-thread
 * titles, recommended follow-ups, notification summaries, initial thinking
 * copy, run summaries, goal objective briefs, and voice I/O polish. These are
 * short, latency-sensitive calls that are not user-selectable, so they share a
 * single model rather than one constant per service.
 */
export const FAST_PATH_MODEL = "google/gemini-3.8-flash";

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

type OpenRouterReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

interface OpenRouterGenerateTextOptions {
  readonly reasoning?: { readonly effort: OpenRouterReasoningEffort };
  readonly temperature?: number;
}

export class OpenRouterRequestError extends Error {
  readonly status: number;
  readonly errorType: string | undefined;
  readonly errorCode: string | number | undefined;
  readonly errorParam: string | undefined;

  constructor(args: {
    readonly message: string;
    readonly status: number;
    readonly errorType?: string;
    readonly errorCode?: string | number;
    readonly errorParam?: string;
  }) {
    const errorType = args.errorType ? ` (${args.errorType})` : "";
    super(`${args.message}: ${String(args.status)}${errorType}`);
    this.name = "OpenRouterRequestError";
    this.status = args.status;
    this.errorType = args.errorType;
    this.errorCode = args.errorCode;
    this.errorParam = args.errorParam;
  }
}

function objectProperty(value: unknown, property: string): unknown | undefined {
  if (typeof value !== "object" || value === null || !(property in value)) {
    return undefined;
  }
  return value[property as keyof typeof value];
}

// Provider diagnostics are untrusted data, including strings that look like
// identifiers. Only retain enumerated values; never retain messages or raw data.
function safeDiagnosticString(
  value: unknown,
  allowed: readonly string[],
): string | undefined {
  return typeof value === "string" && allowed.includes(value)
    ? value
    : undefined;
}

function safeErrorCode(error: unknown): string | number | undefined {
  const code = objectProperty(error, "code");
  if (
    typeof code === "number" &&
    [400, 401, 402, 403, 404, 408, 413, 422, 429, 500, 502, 503, 504].includes(
      code,
    )
  ) {
    return code;
  }
  return safeDiagnosticString(code, [
    "invalid_request_error",
    "invalid_argument",
    "invalid_parameter",
    "unsupported_parameter",
    "unsupported_value",
    "rate_limit_exceeded",
    "INVALID_ARGUMENT",
    "RESOURCE_EXHAUSTED",
    "UNAVAILABLE",
  ]);
}

function safeErrorParam(error: unknown): string | undefined {
  return safeDiagnosticString(objectProperty(error, "param"), [
    "reasoning",
    "reasoning.effort",
    "reasoning_effort",
    "max_tokens",
    "temperature",
  ]);
}

function openRouterRequestError(args: {
  readonly message: string;
  readonly status: number;
  readonly value: unknown;
  readonly origin: "http" | "completion";
}): OpenRouterRequestError {
  const error = objectProperty(args.value, "error") ?? args.value;
  const metadata = objectProperty(error, "metadata");
  const errorType = safeDiagnosticString(
    objectProperty(metadata, "error_type"),
    [
      "invalid_image",
      "image_too_small",
      "unsupported_image_format",
      "image_too_large",
      "image_not_found",
      "image_download_failed",
      "invalid_request_error",
    ],
  );
  // OpenRouter may wrap the provider's JSON error in metadata.raw. Parse just
  // one bounded envelope and apply the same allowlists; never attach it as cause.
  const raw = objectProperty(metadata, "raw");
  const provider =
    typeof raw === "string" && Buffer.byteLength(raw, "utf8") <= 4096
      ? objectProperty(safeJsonParse(raw), "error")
      : undefined;
  const errorCode =
    safeDiagnosticString(objectProperty(provider, "status"), [
      "INVALID_ARGUMENT",
      "RESOURCE_EXHAUSTED",
      "UNAVAILABLE",
    ]) ??
    safeErrorCode(provider) ??
    safeErrorCode(error);
  const errorParam = safeErrorParam(provider) ?? safeErrorParam(error);
  const requestError = new OpenRouterRequestError({
    message: args.message,
    status: args.status,
    ...(errorType === undefined ? {} : { errorType }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(errorParam === undefined ? {} : { errorParam }),
  });
  recordOpenRouterRequestFailure(
    requestError,
    args.status,
    args.origin,
    args.value,
  );
  return requestError;
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
    origin: "http",
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
        origin: "completion",
        value: data,
      });
    }
    throw new Error("OpenRouter returned no choices");
  }
  if (choice.finish_reason === "error") {
    throw openRouterRequestError({
      message: "OpenRouter completion failed",
      status: 502,
      origin: "completion",
      value: choice.error ?? data.error,
    });
  }
  if (choice.finish_reason !== "stop") {
    const nativeFinishReason = safeDiagnosticString(
      choice.native_finish_reason,
      ["MAX_TOKENS", "STOP", "SAFETY", "RECITATION", "OTHER"],
    );
    const finishReason = safeDiagnosticString(choice.finish_reason, [
      "length",
      "content_filter",
      "tool_calls",
    ]);
    const nativeReason = nativeFinishReason
      ? ` (native: ${nativeFinishReason})`
      : "";
    throw new Error(
      `OpenRouter completion finished with ${finishReason ?? "unknown"}${nativeReason}`,
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
  signal?: AbortSignal,
): Promise<string | null> {
  const generation = await generateTextWithUsage(
    model,
    messages,
    maxTokens,
    options,
    signal,
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
  signal?: AbortSignal,
): Promise<OpenRouterTextGeneration | null> {
  const apiKey = optionalEnv("OPENROUTER_API_KEY");
  if (!apiKey) {
    return null;
  }

  const response = await onRejection(
    fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
        ...(options?.reasoning === undefined
          ? {}
          : { reasoning: options.reasoning }),
        temperature: options?.temperature ?? 0.3,
      }),
      signal,
    }),
    recordOpenRouterTransportFailure,
  );
  await onRejection(
    ensureOpenRouterResponseOk(response),
    recordOpenRouterTransportFailure,
  );
  const body = await onRejection(
    response.text(),
    recordOpenRouterTransportFailure,
  );
  const parsed = safeSync(() => {
    // Preserve the shared helper's payload-free parsing and throw contract.
    const data = safeJsonParse(body);
    if (typeof data !== "object" || data === null) {
      throw new Error("OpenRouter returned invalid JSON");
    }
    return parseOpenRouterGeneration(data as OpenRouterResponse);
  });
  if ("error" in parsed) {
    if (!(parsed.error instanceof OpenRouterRequestError)) {
      recordOpenRouterFailure(parsed.error, "invalid_output");
    }
    throw parsed.error;
  }
  return parsed.ok;
}
