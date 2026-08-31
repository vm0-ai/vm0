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
 *
 * Read through globalThis: this module reaches the shared database worker,
 * which has no `window` binding at all.
 */
export const IN_VITEST = Boolean(
  (globalThis as { __vitest_index__?: boolean }).__vitest_index__,
);
