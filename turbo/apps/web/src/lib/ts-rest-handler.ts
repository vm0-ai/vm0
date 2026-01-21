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
import { flushLogs } from "./logger";
import { ingestRequestLog } from "./axiom";
import { ApiError } from "@vm0/core";

// Re-export tsr and TsRestResponse for convenience
export { tsr, TsRestResponse };

/**
 * Standard error handler for ts-rest API routes.
 *
 * Handles ts-rest RequestValidationError and converts it to a proper
 * JSON error response with appropriate status code. Supports body,
 * query, and path parameter validation errors.
 *
 * Usage:
 *   import { createHandler, tsr, validationErrorHandler } from "@/lib/ts-rest-handler";
 *   const handler = createHandler(contract, router, { errorHandler: validationErrorHandler });
 */
export function validationErrorHandler(err: unknown): TsRestResponse | void {
  if (!err || typeof err !== "object") {
    return undefined;
  }

  // Extract first validation issue from any error type
  const errorObj = err as Record<string, unknown>;
  const errorTypes = ["bodyError", "queryError", "pathParamsError"] as const;

  for (const errorType of errorTypes) {
    if (errorType in errorObj && errorObj[errorType]) {
      const validationError = errorObj[errorType] as {
        issues: Array<{ path: string[]; message: string }>;
      };
      const issue = validationError.issues[0];
      if (issue) {
        return TsRestResponse.fromJson(
          {
            error: { message: issue.message, code: ApiError.BAD_REQUEST.code },
          },
          { status: ApiError.BAD_REQUEST.status },
        );
      }
    }
  }

  // Let other errors propagate
  return undefined;
}

/**
 * Type alias for ts-rest router implementation.
 * This is the return type of `tsr.router(contract, { ... })`.
 */
type TsRestRouter<T extends AppRouter> = ReturnType<typeof tsr.router<T>>;

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
  return createNextHandler(contract, router, {
    handlerType: "app-router",
    jsonQuery: true,
    ...options,
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

        // Flush all pending logs to Axiom after each request
        await flushLogs();
      },
    ],
  });
}
