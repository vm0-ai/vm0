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
import type { TsRestResponse } from "@ts-rest/serverless";
import type { AppRouter } from "@ts-rest/core";
import { flushLogs } from "./logger";

// Re-export tsr for convenience
export { tsr };

// Re-export TsRestResponse for error handlers
export { TsRestResponse } from "@ts-rest/serverless";

interface HandlerOptions {
  errorHandler?: (err: unknown) => TsRestResponse | void;
}

/**
 * Create a Next.js route handler with automatic log flushing.
 *
 * @param contract - The ts-rest contract
 * @param router - The ts-rest router implementation
 * @param options - Additional options (errorHandler, etc.)
 */
export function createHandler<T extends AppRouter>(
  contract: T,
  router: ReturnType<typeof tsr.router<T>>,
  options?: HandlerOptions,
) {
  return createNextHandler(contract, router, {
    handlerType: "app-router",
    jsonQuery: true,
    ...options,
    responseHandlers: [
      async () => {
        // Flush all pending logs to Axiom after each request
        await flushLogs();
      },
    ],
  });
}
