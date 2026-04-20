/**
 * Type-safe environment variables for the app.
 *
 * Environment variables are optional until they are actually used.
 * Add validation only when a variable is required by the application.
 */

declare global {
  interface Window {
    __vitest_index__?: boolean;
  }
}

/**
 * Detect if running in Vitest environment.
 * Used for test-specific behavior like promise tracking.
 */
export const IN_VITEST =
  typeof window !== "undefined" && Boolean(window.__vitest_index__);
