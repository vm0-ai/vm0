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

const CODEX_OAUTH_RECONNECT_REQUIRED_MESSAGE =
  "ChatGPT session needs reconnection. Reconnect ChatGPT (Codex) in Model Providers, then retry.";

const codexOAuthReconnectRequiredRunErrorBodySchema = z.object({
  error: z.literal("TOKEN_REFRESH_FAILED"),
  connectors: z.tuple([z.literal("codex-oauth-token")]),
  failureReason: z.literal("reconnect_required"),
});

const codexOAuthReconnectRequiredRunErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.literal("TOKEN_REFRESH_FAILED"),
    connectors: z.tuple([z.literal("codex-oauth-token")]),
    failureReason: z.literal("reconnect_required"),
  }),
});

export const INSUFFICIENT_CREDITS_ASK_ADMIN_MESSAGE =
  "Ask a workspace admin to add credits or upgrade the workspace plan.";

export const ACTIONABLE_RUN_ERROR_SNIPPETS = [
  ...Object.values(RUN_ERROR_GUIDANCE).flatMap((guidance) => {
    return [guidance.title, guidance.guidance];
  }),
  "Cannot continue session",
  "Invalid signature in thinking block",
  "Run cancelled",
  // Upstream model usage/quota limits are shown verbatim (the CLI already
  // emits clean, user-friendly copy with reset time and upgrade links).
  // Codex: "You've hit your usage limit …"
  "usage limit",
  "usage_limit",
  "usage-limit",
  "UsageLimit",
  // Claude Code subscription limits:
  //   "You've hit your session limit · resets …"
  //   "You've hit your weekly limit · resets …"
  "session limit",
  "weekly limit",
  CODEX_OAUTH_RECONNECT_REQUIRED_MESSAGE,
] as const;

function isJsonWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

function findNextJsonObjectStart(
  errorMessage: string,
  searchStart: number,
): number {
  let bodyStart = errorMessage.indexOf("{", searchStart);
  while (bodyStart !== -1) {
    let nextNonWhitespace = bodyStart + 1;
    while (isJsonWhitespace(errorMessage[nextNonWhitespace])) {
      nextNonWhitespace += 1;
    }

    const firstToken = errorMessage[nextNonWhitespace];
    if (firstToken === '"' || firstToken === "}") {
      return bodyStart;
    }
    bodyStart = errorMessage.indexOf("{", bodyStart + 1);
  }
  return -1;
}

function parseNextJsonObject(
  errorMessage: string,
  searchStart: number,
): { readonly value?: unknown; readonly endIndex: number } | undefined {
  const bodyStart = findNextJsonObjectStart(errorMessage, searchStart);
  if (bodyStart === -1) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = bodyStart; index < errorMessage.length; index += 1) {
    const char = errorMessage[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char !== "}") {
      continue;
    }

    depth -= 1;
    if (depth !== 0) {
      continue;
    }

    try {
      return {
        value: JSON.parse(errorMessage.slice(bodyStart, index + 1)) as unknown,
        endIndex: index + 1,
      };
    } catch {
      return { endIndex: index + 1 };
    }
  }

  return { endIndex: errorMessage.length };
}

function isCodexOAuthReconnectRequiredRunErrorObject(value: unknown): boolean {
  return (
    codexOAuthReconnectRequiredRunErrorBodySchema.safeParse(value).success ||
    codexOAuthReconnectRequiredRunErrorEnvelopeSchema.safeParse(value).success
  );
}

function isCodexOAuthReconnectRequiredRunError(errorMessage: string): boolean {
  if (
    !errorMessage.includes("TOKEN_REFRESH_FAILED") ||
    !errorMessage.includes("codex-oauth-token") ||
    !errorMessage.includes("reconnect_required")
  ) {
    return false;
  }

  let searchStart = 0;
  let parsed = parseNextJsonObject(errorMessage, searchStart);
  while (parsed !== undefined) {
    if (isCodexOAuthReconnectRequiredRunErrorObject(parsed?.value)) {
      return true;
    }
    searchStart = parsed.endIndex;
    parsed = parseNextJsonObject(errorMessage, searchStart);
  }
  return false;
}

function hasActionableRunErrorSnippet(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return ACTIONABLE_RUN_ERROR_SNIPPETS.some((snippet) => {
    return normalized.includes(snippet.toLowerCase());
  });
}

export function isActionableRunError(errorMessage: string): boolean {
  return (
    isCodexOAuthReconnectRequiredRunError(errorMessage) ||
    hasActionableRunErrorSnippet(errorMessage)
  );
}

export function isGenericRunErrorForDisplay(errorMessage: string): boolean {
  const normalizedErrorMessage = errorMessage.trim() || "Run failed";
  return !isActionableRunError(normalizedErrorMessage);
}

/**
 * Plain-text run error copy shared by Web chat and external integrations.
 * Web may wrap generic failures with its report-link affordance after this
 * shared classification step.
 */
export function formatRunErrorForExternalSurface(params: {
  readonly code: string;
  readonly message: string;
  readonly insufficientCredits?:
    | {
        readonly canManageBilling: boolean;
        readonly addCreditsUrl: string;
        readonly comparePlansUrl?: string;
      }
    | {
        readonly canManageBilling: boolean;
        readonly comparePlansUrl: string;
        readonly addCreditsUrl?: string;
      };
}): string {
  const errorMessage = params.message.trim() || "Run failed";

  if (
    params.code === "INSUFFICIENT_CREDITS" &&
    params.insufficientCredits !== undefined
  ) {
    if (!params.insufficientCredits.canManageBilling) {
      return INSUFFICIENT_CREDITS_ASK_ADMIN_MESSAGE;
    }
    const addCreditsUrl =
      params.insufficientCredits.addCreditsUrl ??
      params.insufficientCredits.comparePlansUrl;
    return `${errorMessage}\n\nAdd credits: ${addCreditsUrl}`;
  }

  if (isCodexOAuthReconnectRequiredRunError(errorMessage)) {
    return CODEX_OAUTH_RECONNECT_REQUIRED_MESSAGE;
  }

  return hasActionableRunErrorSnippet(errorMessage)
    ? errorMessage
    : CHAT_RUN_TRANSIENT_ERROR_MESSAGE;
}
