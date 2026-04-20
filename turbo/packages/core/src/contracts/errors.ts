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
    cliHint: "zero org model-provider setup",
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
  TOO_MANY_REQUESTS: {
    title: "Concurrent run limit reached",
    guidance:
      "Wait for your current run to complete before starting a new one.",
  },
};
