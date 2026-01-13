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
import { recordApiRequest, flushMetrics } from "../metrics";

// Re-export tsr for convenience
export { tsr };

// Re-export TsRestResponse for error handlers
export { TsRestResponse } from "@ts-rest/serverless";

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
    jsonQuery: true,
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

        // Record API metrics
        const startTime = requestStartTimes.get(request);
        if (startTime !== undefined) {
          const url = new URL(request.url);
          recordApiRequest({
            method: request.method,
            pathTemplate: request.route,
            statusCode: response.status,
            host: url.host,
            durationMs: Date.now() - startTime,
          });
          requestStartTimes.delete(request);
        }

        // Flush all pending logs and metrics to Axiom after each request
        await Promise.all([flushLogs(), flushMetrics()]);
      },
    ],
  });
}

/**
 * Middleware context for public API handlers.
 */
export interface PublicApiContext {
  requestId: string;
  userId: string | null;
}

/**
 * Create a context object for public API handlers
 */
export function createPublicApiContext(
  requestId: string,
  userId: string | null = null,
): PublicApiContext {
  return {
    requestId,
    userId,
  };
}
