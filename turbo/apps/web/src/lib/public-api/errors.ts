/**
 * Public API v1 Error Handling
 *
 * Provides standardized error responses following Stripe-style patterns.
 */
import { TsRestResponse } from "@ts-rest/serverless";
import {
  type PublicApiErrorType,
  PublicApiErrorCode,
  createPublicApiError,
  errorTypeToStatus,
} from "@vm0/core";

/**
 * Create a TsRestResponse for a public API error
 */
function createPublicApiErrorResponse(
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
function invalidParameterError(param: string, message: string): TsRestResponse {
  return createPublicApiErrorResponse(
    "invalid_request_error",
    PublicApiErrorCode.INVALID_PARAMETER,
    message,
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
 * 500 Internal Server Error
 */
function internalServerError(message?: string): TsRestResponse {
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
