import { z } from "zod";

/**
 * API error definitions with associated HTTP status codes
 * Used across all API endpoints for consistent error responses
 */
export const ApiError = {
  BAD_REQUEST: { status: 400 as const, code: "BAD_REQUEST" },
  UNAUTHORIZED: { status: 401 as const, code: "UNAUTHORIZED" },
  FORBIDDEN: { status: 403 as const, code: "FORBIDDEN" },
  NOT_FOUND: { status: 404 as const, code: "NOT_FOUND" },
  CONFLICT: { status: 409 as const, code: "CONFLICT" },
  RUN_NOT_CANCELLABLE: {
    status: 400 as const,
    code: "RUN_NOT_CANCELLABLE",
  },
  INSUFFICIENT_CREDITS: {
    status: 402 as const,
    code: "INSUFFICIENT_CREDITS",
  },
  PAYLOAD_TOO_LARGE: { status: 413 as const, code: "PAYLOAD_TOO_LARGE" },
  TOO_MANY_REQUESTS: { status: 429 as const, code: "TOO_MANY_REQUESTS" },
  NO_MODEL_PROVIDER: {
    status: 422 as const,
    code: "NO_MODEL_PROVIDER",
  },
  PROVIDER_UNAVAILABLE: {
    status: 503 as const,
    code: "PROVIDER_UNAVAILABLE",
  },
  PROVIDER_DELETED: {
    status: 422 as const,
    code: "PROVIDER_DELETED",
  },
  CODEX_AUTH_JSON_SHAPE_INVALID: {
    status: 400 as const,
    code: "CODEX_AUTH_JSON_SHAPE_INVALID",
  },
  CODEX_FREE_PLAN_REJECTED: {
    status: 400 as const,
    code: "CODEX_FREE_PLAN_REJECTED",
  },
  INTERNAL_SERVER_ERROR: {
    status: 500 as const,
    code: "INTERNAL_SERVER_ERROR",
  },
} as const;

export type ApiErrorKey = keyof typeof ApiError;

/**
 * Helper to create a standardized error response
 * Ensures the correct HTTP status code is always used with the error code
 */
export function createErrorResponse<K extends ApiErrorKey>(
  errorKey: K,
  message: string,
) {
  const { status, code } = ApiError[errorKey];
  return {
    status,
    body: { error: { message, code } },
  };
}

/**
 * Standard API error response schema
 * Used across all API endpoints for consistent error handling
 */
export const apiErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    code: z.string(),
  }),
});

export type ApiErrorResponse = z.infer<typeof apiErrorSchema>;

/**
 * Centralized guidance registry for run error codes.
 * All client surfaces (Web, CLI, Slack, Telegram) use this to render
 * actionable error messages. To add a new error code, add an entry here
 * and create the corresponding factory function in errors.ts.
 */
export const RUN_ERROR_GUIDANCE: Record<
  string,
  { title: string; guidance: string; cliHint?: string }
> = {
  NO_MODEL_PROVIDER: {
    title: "No model provider configured",
    guidance: "Configure a model provider to start running agents.",
    cliHint: "zero model-provider set --help",
  },
  INSUFFICIENT_CREDITS: {
    title: "Credits depleted",
    guidance: "Add credits or configure your own API key to continue.",
  },
  PROVIDER_INCOMPATIBLE: {
    title: "Provider not compatible",
    guidance: "This session was created with a different provider type.",
  },
  PROVIDER_UNAVAILABLE: {
    title: "Provider temporarily unavailable",
    guidance:
      "The model provider is temporarily unavailable. Please try again later.",
  },
  PROVIDER_DELETED: {
    title: "Model provider unavailable",
    guidance:
      "The model provider used by this thread has been deleted. Start a new chat thread to continue.",
  },
  TOO_MANY_REQUESTS: {
    title: "Concurrent run limit reached",
    guidance:
      "Wait for your current run to complete before starting a new one.",
  },
};

export const CHAT_RUN_TRANSIENT_ERROR_MESSAGE =
  "Oops, something went wrong. Please try again later.";

export const ACTIONABLE_RUN_ERROR_SNIPPETS = [
  ...Object.values(RUN_ERROR_GUIDANCE).flatMap((guidance) => {
    return [guidance.title, guidance.guidance];
  }),
  "Cannot continue session",
  "Invalid signature in thinking block",
  "Run cancelled",
  "usage limit",
  "usage_limit",
  "usage-limit",
  "UsageLimit",
] as const;

export function isActionableRunError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return ACTIONABLE_RUN_ERROR_SNIPPETS.some((snippet) => {
    return normalized.includes(snippet.toLowerCase());
  });
}

/**
 * Plain-text run error copy that matches the Web chat error behavior.
 * Actionable allowlisted errors are shown as-is; generic failures are hidden
 * behind the same transient "Oops" message Web chat uses.
 */
export function formatRunErrorForExternalSurface(params: {
  readonly code: string;
  readonly message: string;
}): string {
  const errorMessage = params.message.trim() || "Run failed";
  const chatgptCodexUsageLimitMessage =
    formatChatgptCodexUsageLimitError(errorMessage);
  if (chatgptCodexUsageLimitMessage) {
    return chatgptCodexUsageLimitMessage;
  }

  return isActionableRunError(errorMessage)
    ? errorMessage
    : CHAT_RUN_TRANSIENT_ERROR_MESSAGE;
}

const CHATGPT_CODEX_USAGE_DETAILS_URL =
  "https://chatgpt.com/codex/settings/usage";

function isChatgptCodexUsageLimitError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return (
    normalized.includes("usage limit") &&
    (normalized.includes("chatgpt.com/codex") ||
      normalized.includes("codex/settings/usage") ||
      normalized.includes("chatgpt codex"))
  );
}

function extractChatgptCodexRetryPhrase(errorMessage: string): string | null {
  const match = /\btry again\s+(at|after|in)\s+([^.;\n\r]+)/i.exec(
    errorMessage,
  );
  if (!match) {
    return null;
  }

  const preposition = match[1];
  const retryAt = match[2]?.trim();
  if (!preposition || !retryAt) {
    return null;
  }
  if (retryAt.length > 80 || !/^[a-z0-9\s:,+/-]+$/i.test(retryAt)) {
    return null;
  }

  return `${preposition.toLowerCase()} ${retryAt}`;
}

export function formatChatgptCodexUsageLimitError(
  errorMessage: string,
): string | null {
  if (!isChatgptCodexUsageLimitError(errorMessage)) {
    return null;
  }

  const retryPhrase = extractChatgptCodexRetryPhrase(errorMessage);
  const retrySentence = retryPhrase ? ` This limit resets ${retryPhrase}.` : "";
  return `ChatGPT Codex usage limit reached.${retrySentence} View details in [ChatGPT Codex usage settings](${CHATGPT_CODEX_USAGE_DETAILS_URL}), or switch to another model to continue now.`;
}
