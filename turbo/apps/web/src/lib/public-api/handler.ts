/**
 * Public API v1 Handler
 *
 * Unified handler creation for public API routes with:
 * - Request ID tracking
 * - Standardized error handling
 * - Automatic log flushing
 */
import "server-only";
import { createNextHandler, tsr } from "@ts-rest/serverless/next";
import type { TsRestResponse } from "@ts-rest/serverless";
import type { AppRouter } from "@ts-rest/core";
import { flushLogs } from "../logger";
import { REQUEST_ID_HEADER, generateRequestId } from "./request-id";
import { publicApiErrorHandler } from "./errors";

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

/**
 * Create a Next.js route handler for public API v1 endpoints.
 *
 * This wrapper provides:
 * - Request ID generation and tracking
 * - Standardized error handling (Stripe-style)
 * - Automatic log flushing
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
    responseHandlers: [
      async (response) => {
        // Generate and add request ID
        const requestId = generateRequestId();
        response.headers.set(REQUEST_ID_HEADER, requestId);

        // Add API version header
        response.headers.set("X-API-Version", "v1");

        // Flush all pending logs to Axiom after each request
        await flushLogs();
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
