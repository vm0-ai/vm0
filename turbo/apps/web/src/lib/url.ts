/**
 * URL utilities for deriving related service URLs
 */

/**
 * Resolves the Platform URL from the current browser origin.
 * Replaces "www" with "platform" in the hostname.
 *
 * This is the inverse of resolveApiBase() in apps/platform/src/signals/fetch.ts,
 * which replaces "platform" with "www" to get the API URL.
 *
 * @example
 * // In browser at https://www.vm0.ai
 * getPlatformUrl() // returns "https://platform.vm0.ai"
 *
 * // In browser at https://www.vm7.ai:8443
 * getPlatformUrl() // returns "https://platform.vm7.ai:8443"
 *
 * @returns The platform URL derived from the current origin
 */
export function getPlatformUrl(): string {
  if (typeof window === "undefined") {
    // Fallback for server-side rendering
    return "https://platform.vm0.ai";
  }

  const currentOrigin = window.location.origin;
  const url = new URL(currentOrigin);
  url.hostname = url.hostname.replace("www", "platform");
  return url.origin;
}
