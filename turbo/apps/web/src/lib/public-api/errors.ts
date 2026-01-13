/**
 * Public API v1 Error Handling
 *
 * Provides standardized error responses following Stripe-style patterns.
 */
import { TsRestResponse } from "@ts-rest/serverless";
import {
  type PublicApiErrorType,
  type PublicApiError,
  PublicApiErrorCode,
  createPublicApiError,
  errorTypeToStatus,
} from "@vm0/core";

/**
 * Create a TsRestResponse for a public API error
 */
export function createPublicApiErrorResponse(
  type: PublicApiErrorType,
  code: string,
  message: string,
  options?: { param?: string; docUrl?: string },
): TsRestResponse {
  const status = errorTypeToStatus[type];
  const body = createPublicApiError(type, code, message, options);

  return TsRestResponse.fromJson(body, { status });
}

// Pre-built error response helpers for common cases

/**
 * 400 Bad Request - Invalid parameter
 */
export function invalidParameterError(
  param: string,
  message: string,
): TsRestResponse {
  return createPublicApiErrorResponse(
    "invalid_request_error",
    PublicApiErrorCode.INVALID_PARAMETER,
    message,
    { param },
  );
}

/**
 * 400 Bad Request - Missing parameter
 */
export function missingParameterError(param: string): TsRestResponse {
  return createPublicApiErrorResponse(
    "invalid_request_error",
    PublicApiErrorCode.MISSING_PARAMETER,
    `Missing required parameter: ${param}`,
    { param },
  );
}

/**
 * 401 Unauthorized - Invalid API key
 */
export function invalidApiKeyError(): TsRestResponse {
  return createPublicApiErrorResponse(
    "authentication_error",
    PublicApiErrorCode.INVALID_API_KEY,
    "Invalid API key provided",
  );
}

/**
 * 401 Unauthorized - Expired API key
 */
export function expiredApiKeyError(): TsRestResponse {
  return createPublicApiErrorResponse(
    "authentication_error",
    PublicApiErrorCode.EXPIRED_API_KEY,
    "API key has expired",
  );
}

/**
 * 401 Unauthorized - Missing API key
 */
export function missingApiKeyError(): TsRestResponse {
  return createPublicApiErrorResponse(
    "authentication_error",
    PublicApiErrorCode.MISSING_API_KEY,
    "No API key provided. Include Authorization: Bearer vm0_live_xxx header.",
  );
}

/**
 * 404 Not Found - Resource not found
 */
export function resourceNotFoundError(
  resourceType: string,
  resourceId: string,
): TsRestResponse {
  return createPublicApiErrorResponse(
    "not_found_error",
    PublicApiErrorCode.RESOURCE_NOT_FOUND,
    `No such ${resourceType}: '${resourceId}'`,
  );
}

/**
 * 409 Conflict - Resource already exists
 */
export function resourceAlreadyExistsError(
  resourceType: string,
  identifier: string,
): TsRestResponse {
  return createPublicApiErrorResponse(
    "conflict_error",
    PublicApiErrorCode.RESOURCE_ALREADY_EXISTS,
    `A ${resourceType} with this identifier already exists: '${identifier}'`,
  );
}

/**
 * 500 Internal Server Error
 */
export function internalServerError(message?: string): TsRestResponse {
  return createPublicApiErrorResponse(
    "api_error",
    PublicApiErrorCode.INTERNAL_ERROR,
    message ?? "An internal error occurred. Please try again later.",
  );
}

/**
 * Error handler for ts-rest validation errors
 */
export function publicApiErrorHandler(err: unknown): TsRestResponse | void {
  // Handle Zod validation errors
  if (
    err &&
    typeof err === "object" &&
    "name" in err &&
    err.name === "ZodError"
  ) {
    const zodError = err as {
      issues?: Array<{ path: string[]; message: string }>;
    };
    const firstIssue = zodError.issues?.[0];
    if (firstIssue) {
      const param = firstIssue.path.join(".");
      return invalidParameterError(param, firstIssue.message);
    }
    return invalidParameterError("unknown", "Invalid request parameters");
  }

  // Log unexpected errors for debugging
  console.error("[public-api] Unhandled error:", err);

  // Return 500 for unhandled errors
  return internalServerError();
}

/**
 * Type guard to check if an error is a PublicApiError
 */
export function isPublicApiError(value: unknown): value is PublicApiError {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as PublicApiError).error === "object" &&
    "type" in (value as PublicApiError).error &&
    "code" in (value as PublicApiError).error &&
    "message" in (value as PublicApiError).error
  );
}
