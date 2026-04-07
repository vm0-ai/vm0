/**
 * Unified ts-rest handler configuration with automatic log flushing.
 *
 * This module wraps createNextHandler to ensure all logs are flushed
 * to Axiom before the serverless function terminates.
 *
 * Usage:
 *   import { createHandler, tsr } from "@/lib/ts-rest-handler";
 *
 *   const router = tsr.router(contract, { ... });
 *   const handler = createHandler(contract, router);
 *   export { handler as GET, handler as POST };
 */
import "server-only";
import { createNextHandler, tsr } from "@ts-rest/serverless/next";
import { TsRestResponse } from "@ts-rest/serverless";
import type { TsRestRequest } from "@ts-rest/serverless";
import type { AppRouter } from "@ts-rest/core";
import { flushLogs, logger } from "./shared/logger";
import { ingestRequestLog, flushAxiom } from "./shared/axiom";
import { isApiError } from "./shared/errors";

// Re-export tsr and TsRestResponse for convenience
export { tsr, TsRestResponse };

/**
 * Type alias for ts-rest router implementation.
 * This is the return type of `tsr.router(contract, { ... })`.
 */
type TsRestRouter<T extends AppRouter> = ReturnType<typeof tsr.router<T>>;

/**
 * Create a safe error handler that sanitizes error messages for API responses.
 *
 * - Zod validation errors (bodyError/queryError) are safe to return as-is
 * - All other errors are logged server-side with full details but return
 *   a generic message to the client (CWE-209, OWASP ASVS V7.4.1)
 *
 * @param routeName - Route identifier for server-side logging
 */
export function createSafeErrorHandler(
  routeName: string,
): (err: unknown) => TsRestResponse | void {
  const log = logger(`api:${routeName}`);

  return function safeErrorHandler(err: unknown): TsRestResponse | void {
    // Zod/standard-schema validation errors are safe to return (field names + validation messages)
    if (err && typeof err === "object") {
      // ts-rest validation errors have bodyError, queryError, and/or pathParamsError
      const hasValidationFields =
        "bodyError" in err || "queryError" in err || "pathParamsError" in err;

      if (hasValidationFields) {
        const validationError = err as {
          bodyError?: {
            issues: Array<{ path: string[]; message: string }>;
          } | null;
          queryError?: {
            issues: Array<{ path: string[]; message: string }>;
          } | null;
          pathParamsError?: {
            issues: Array<{ path: string[]; message: string }>;
          } | null;
        };

        const source =
          validationError.pathParamsError ??
          validationError.bodyError ??
          validationError.queryError;
        const sourceLabel = validationError.pathParamsError
          ? "pathParams"
          : validationError.bodyError
            ? "body"
            : "query";
        if (source) {
          const issue = source.issues[0];
          if (issue) {
            const path = issue.path.join(".");
            const message = path ? `${path}: ${issue.message}` : issue.message;
            log.warn(`validation error (${sourceLabel}): ${message}`);
            return TsRestResponse.fromJson(
              { error: { message, code: "BAD_REQUEST" } },
              { status: 400 },
            );
          }
        }
      }
    }

    // Application errors with explicit status codes (BadRequest, NotFound, etc.)
    if (isApiError(err)) {
      log.error(`${routeName} error:`, err);
      return TsRestResponse.fromJson(
        { error: { message: err.message, code: err.code } },
        { status: err.statusCode },
      );
    }

    // Non-validation errors: log full details server-side, return generic message
    log.error(`${routeName} error:`, err);
    return TsRestResponse.fromJson(
      {
        error: {
          message: "An internal error occurred. Please try again later.",
          code: "INTERNAL_ERROR",
        },
      },
      { status: 500 },
    );
  };
}

/**
 * Options for createHandler.
 */
interface CreateHandlerOptions {
  /** Custom error handler for validation and other errors */
  errorHandler?: (err: unknown) => TsRestResponse | void;
}

// WeakMap to store request start times
const requestStartTimes = new WeakMap<TsRestRequest, number>();

/**
 * Create a Next.js route handler with automatic log flushing.
 *
 * This wrapper ensures all logs are flushed to Axiom before the
 * serverless function terminates, preventing log loss.
 *
 * @param contract - The ts-rest contract definition
 * @param router - The ts-rest router implementation (from tsr.router)
 * @param options - Additional options (errorHandler, etc.)
 */
export function createHandler<T extends AppRouter>(
  contract: T,
  router: TsRestRouter<T>,
  options?: CreateHandlerOptions,
) {
  const resolvedOptions = {
    ...options,
    errorHandler:
      options?.errorHandler ?? createSafeErrorHandler("unknown-route"),
  };

  return createNextHandler(contract, router, {
    handlerType: "app-router",
    // jsonQuery is intentionally disabled: JSON.parse() misinterprets hex strings
    // like "846e3519" as scientific notation, corrupting version query params (#2666)
    jsonQuery: false,
    ...resolvedOptions,
    requestMiddleware: [
      (request) => {
        // Record request start time
        requestStartTimes.set(request, Date.now());
      },
    ],
    responseHandlers: [
      async (response, request) => {
        // Record request log (nginx-style)
        const startTime = requestStartTimes.get(request);
        if (startTime !== undefined) {
          const url = new URL(request.url);
          ingestRequestLog({
            remote_addr:
              request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
              "unknown",
            user_agent: request.headers.get("user-agent") || "",
            method: request.method,
            path_template: request.route,
            host: url.host,
            status: response.status,
            body_bytes_sent: 0, // Not available from TsRestResponse
            request_time_ms: Date.now() - startTime,
          });
          requestStartTimes.delete(request);
        }

        // Flush all pending logs and ingested events to Axiom
        await Promise.all([flushLogs(), flushAxiom()]);
      },
    ],
  });
}
