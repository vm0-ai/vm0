/**
 * Public API v1 Handler
 *
 * Unified handler creation for public API routes with:
 * - Request ID tracking
 * - Standardized error handling
 * - Automatic log flushing
 * - RED metrics collection
 */
import "server-only";
import { createNextHandler, tsr } from "@ts-rest/serverless/next";
import type { TsRestResponse, TsRestRequest } from "@ts-rest/serverless";
import type { AppRouter } from "@ts-rest/core";
import { flushLogs } from "../logger";
import { REQUEST_ID_HEADER, generateRequestId } from "./request-id";
import { publicApiErrorHandler } from "./errors";
import { ingestRequestLog } from "../axiom";

// Re-export tsr for convenience
export { tsr };

/**
 * Type alias for ts-rest router implementation.
 */
type TsRestRouter<T extends AppRouter> = ReturnType<typeof tsr.router<T>>;

/**
 * Options for createPublicApiHandler.
 */
interface CreatePublicApiHandlerOptions {
  /** Custom error handler for validation and other errors */
  errorHandler?: (err: unknown) => TsRestResponse | void;
}

// WeakMap to store request start times
const requestStartTimes = new WeakMap<TsRestRequest, number>();

/**
 * Create a Next.js route handler for public API v1 endpoints.
 *
 * This wrapper provides:
 * - Request ID generation and tracking
 * - Standardized error handling (Stripe-style)
 * - Automatic log flushing
 * - RED metrics collection
 *
 * @param contract - The ts-rest contract definition
 * @param router - The ts-rest router implementation (from tsr.router)
 * @param options - Additional options (errorHandler, etc.)
 */
export function createPublicApiHandler<T extends AppRouter>(
  contract: T,
  router: TsRestRouter<T>,
  options?: CreatePublicApiHandlerOptions,
) {
  return createNextHandler(contract, router, {
    handlerType: "app-router",
    // jsonQuery is intentionally disabled: JSON.parse() misinterprets hex strings
    // like "846e3519" as scientific notation, corrupting version query params (#2666)
    jsonQuery: false,
    errorHandler: options?.errorHandler ?? publicApiErrorHandler,
    requestMiddleware: [
      (request) => {
        // Record request start time
        requestStartTimes.set(request, Date.now());
      },
    ],
    responseHandlers: [
      async (response, request) => {
        // Generate and add request ID
        const requestId = generateRequestId();
        response.headers.set(REQUEST_ID_HEADER, requestId);

        // Add API version header
        response.headers.set("X-API-Version", "v1");

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
