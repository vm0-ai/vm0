/**
 * Axiom server-side logging setup for Next.js route handlers.
 *
 * This module provides:
 * - `logger` - Axiom Logger instance for structured logging
 * - `withAxiom` - Route handler wrapper that auto-flushes logs
 *
 * Usage in route handlers:
 *   import { withAxiom, logger } from '@/lib/axiom/server';
 *
 *   export const GET = withAxiom(async (req) => {
 *     logger.info('handling request', { userId: '123' });
 *     return Response.json({ data });
 *   });
 *
 * The withAxiom wrapper automatically:
 * - Logs request/response info (method, path, status, duration)
 * - Flushes logs before function terminates (critical for serverless)
 * - Catches and logs errors
 * - Uses Next.js 15 after() API for non-blocking flush when available
 */
import "server-only";
import { Logger, AxiomJSTransport, ConsoleTransport } from "@axiomhq/logging";
import { createAxiomRouteHandler, nextJsFormatters } from "@axiomhq/nextjs";
import { Axiom } from "@axiomhq/js";
import { getDatasetName, DATASETS } from "./datasets";

// Axiom client singleton
let axiomClient: Axiom | null = null;

function getAxiom(): Axiom | null {
  const token = process.env.AXIOM_TOKEN;
  if (!token) {
    return null;
  }
  if (!axiomClient) {
    axiomClient = new Axiom({ token });
  }
  return axiomClient;
}

// Logger singleton
let axiomLogger: Logger | null = null;

function createLogger(): Logger | null {
  const axiom = getAxiom();
  if (!axiom) {
    return null;
  }

  return new Logger({
    transports: [
      // Dual-write: Axiom (structured, queryable) + Console (Vercel logs, real-time)
      new AxiomJSTransport({
        axiom,
        dataset: getDatasetName(DATASETS.WEB_LOGS),
      }),
      new ConsoleTransport(),
    ],
    formatters: nextJsFormatters,
  });
}

/**
 * Get the Axiom logger instance.
 * Returns a no-op logger if AXIOM_TOKEN is not configured.
 */
export function getLogger(): Logger {
  if (!axiomLogger) {
    axiomLogger = createLogger();
  }

  // Return actual logger or no-op logger
  if (axiomLogger) {
    return axiomLogger;
  }

  // No-op logger when Axiom is not configured
  const noop = () => {};
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    log: noop,
    with: () => getLogger(),
    flush: async () => {},
    raw: noop,
  } as unknown as Logger;
}

/**
 * Axiom logger instance for structured logging.
 * Use this for logging within route handlers wrapped with withAxiom.
 */
export const logger = getLogger();

/**
 * Route handler wrapper that automatically logs requests and flushes to Axiom.
 *
 * Usage:
 *   export const GET = withAxiom(async (req) => {
 *     logger.info('doing something');
 *     return Response.json({ data });
 *   });
 */
export const withAxiom = createAxiomRouteHandler(getLogger());

/**
 * Reset the logger singleton (for testing).
 */
export function resetAxiomLogger(): void {
  axiomLogger = null;
  axiomClient = null;
}
