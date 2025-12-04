import { headers } from "next/headers";

/**
 * WeakMap to store debug state per request.
 * Uses the Headers object as key since Next.js returns the same Headers instance
 * for the duration of a request.
 */
const debugStateMap = new WeakMap<object, boolean>();

/**
 * Enable debug mode for the current request.
 * Should be called after verifying the user is allowed to enable debug.
 *
 * @param headersList - The Headers object from the current request
 */
export function enableRequestDebug(headersList: object): void {
  debugStateMap.set(headersList, true);
}

/**
 * Check if debug logging is enabled for the current request.
 * Returns true if the current request has debug mode enabled (vm0.ai user with VM0_DEBUG).
 */
export function isRequestDebugEnabled(): boolean {
  try {
    // headers() returns the same object for the duration of a request
    const headersList = headers();
    return debugStateMap.get(headersList) ?? false;
  } catch {
    // Not in a request context (e.g., build time, background jobs)
    return false;
  }
}
