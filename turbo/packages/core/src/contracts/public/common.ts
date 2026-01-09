/**
 * Common schemas for the Public API v1
 *
 * This file defines standardized response types following industry best practices:
 * - Stripe-style error responses
 * - Cursor-based pagination
 */
import { z } from "zod";

/**
 * Error types following Stripe's error taxonomy
 */
export const publicApiErrorTypeSchema = z.enum([
  "api_error", // Internal server error (5xx)
  "invalid_request_error", // Bad parameters (400)
  "authentication_error", // Auth failure (401)
  "not_found_error", // Resource missing (404)
  "conflict_error", // Resource conflict (409)
]);

export type PublicApiErrorType = z.infer<typeof publicApiErrorTypeSchema>;

/**
 * Public API error response schema (Stripe-style)
 *
 * Example:
 * {
 *   "error": {
 *     "type": "invalid_request_error",
 *     "code": "resource_missing",
 *     "message": "No such agent: 'xxx'",
 *     "param": "agent_id",
 *     "doc_url": "https://docs.vm0.dev/errors/resource_missing"
 *   }
 * }
 */
export const publicApiErrorSchema = z.object({
  error: z.object({
    type: publicApiErrorTypeSchema,
    code: z.string(),
    message: z.string(),
    param: z.string().optional(),
    doc_url: z.string().url().optional(),
  }),
});

export type PublicApiError = z.infer<typeof publicApiErrorSchema>;

/**
 * Error codes for the Public API
 */
export const PublicApiErrorCode = {
  // Authentication errors
  INVALID_API_KEY: "invalid_api_key",
  EXPIRED_API_KEY: "expired_api_key",
  REVOKED_API_KEY: "revoked_api_key",
  MISSING_API_KEY: "missing_api_key",

  // Resource errors
  RESOURCE_NOT_FOUND: "resource_not_found",
  RESOURCE_ALREADY_EXISTS: "resource_already_exists",

  // Validation errors
  INVALID_PARAMETER: "invalid_parameter",
  MISSING_PARAMETER: "missing_parameter",

  // Server errors
  INTERNAL_ERROR: "internal_error",
} as const;

export type PublicApiErrorCodeType =
  (typeof PublicApiErrorCode)[keyof typeof PublicApiErrorCode];

/**
 * Helper to create standardized error responses
 */
export function createPublicApiError(
  type: PublicApiErrorType,
  code: string,
  message: string,
  options?: { param?: string; docUrl?: string },
): PublicApiError {
  return {
    error: {
      type,
      code,
      message,
      param: options?.param,
      doc_url: options?.docUrl,
    },
  };
}

/**
 * Map error types to HTTP status codes
 */
export const errorTypeToStatus: Record<PublicApiErrorType, number> = {
  api_error: 500,
  invalid_request_error: 400,
  authentication_error: 401,
  not_found_error: 404,
  conflict_error: 409,
};

/**
 * Cursor-based pagination schema
 *
 * Example:
 * {
 *   "data": [...],
 *   "pagination": {
 *     "has_more": true,
 *     "next_cursor": "eyJpZCI6MTIzfQ=="
 *   }
 * }
 */
export const paginationSchema = z.object({
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});

export type Pagination = z.infer<typeof paginationSchema>;

/**
 * Helper to create a paginated response schema for a given data type
 */
export function createPaginatedResponseSchema<T extends z.ZodTypeAny>(
  dataSchema: T,
) {
  return z.object({
    data: z.array(dataSchema),
    pagination: paginationSchema,
  });
}

/**
 * Common query parameters for list endpoints
 */
export const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(20),
});

export type ListQuery = z.infer<typeof listQuerySchema>;

/**
 * Request ID schema
 * Every response includes X-Request-Id header
 */
export const requestIdSchema = z.string().uuid();

/**
 * Timestamp schema (ISO 8601 format)
 */
export const timestampSchema = z.string().datetime();

/**
 * ID prefix patterns for public API resources
 */
export const ID_PREFIXES = {
  AGENT: "ag_",
  RUN: "run_",
  ARTIFACT: "art_",
  VOLUME: "vol_",
  TOKEN: "tok_",
  SESSION: "sess_",
  CHECKPOINT: "chk_",
} as const;

/**
 * Token prefix patterns
 */
export const TOKEN_PREFIXES = {
  CLI: "vm0_live_",
  TEST: "vm0_test_",
} as const;
