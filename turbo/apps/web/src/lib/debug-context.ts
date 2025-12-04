import { AsyncLocalStorage } from "async_hooks";

interface DebugContext {
  enabled: boolean;
}

/**
 * AsyncLocalStorage for request-scoped debug flag.
 * This allows logger.debug() to know if debug mode is enabled for the current request.
 */
export const debugContext = new AsyncLocalStorage<DebugContext>();

/**
 * Check if debug logging is enabled for the current request.
 * Returns true if the current request has debug mode enabled (vm0.ai user with VM0_DEBUG).
 */
export function isRequestDebugEnabled(): boolean {
  const ctx = debugContext.getStore();
  return ctx?.enabled ?? false;
}

/**
 * Run a function with debug context enabled or disabled.
 * Used to wrap request handlers with the appropriate debug setting.
 */
export function runWithDebugContext<T>(enabled: boolean, fn: () => T): T {
  return debugContext.run({ enabled }, fn);
}
