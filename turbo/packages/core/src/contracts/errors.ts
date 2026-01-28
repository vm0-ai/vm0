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
  TOO_MANY_REQUESTS: { status: 429 as const, code: "TOO_MANY_REQUESTS" },
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
