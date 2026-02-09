// Sentry instrumentation - must be imported before any other modules
// Sentry auto-captures uncaught exceptions and unhandled rejections by default.
// We use beforeSend to filter out operational errors (user mistakes, expected failures).
// Only programmer errors (bugs) should reach Sentry.
import * as Sentry from "@sentry/node";
import * as os from "node:os";

declare const __CLI_VERSION__: string;
declare const __DEFAULT_SENTRY_DSN__: string;

// Runtime SENTRY_DSN takes precedence, then build-time default
const DSN = process.env.SENTRY_DSN ?? __DEFAULT_SENTRY_DSN__;

/**
 * Patterns for operational errors that should NOT be sent to Sentry.
 * These are user errors or expected failures, not bugs.
 */
const OPERATIONAL_ERROR_PATTERNS = [
  // Authentication errors (user needs to login)
  /not authenticated/i,
  // Resource not found (user typo or deleted resource)
  /not found/i,
  /agent not found/i,
  /version not found/i,
  /checkpoint not found/i,
  /session not found/i,
  // File errors (user provided wrong path)
  /file not found/i,
  /environment file not found/i,
  // Validation errors (user input issues)
  /invalid format/i,
  /invalid.*config/i,
  // Rate limiting (expected operational condition)
  /rate limit/i,
  /concurrent run limit/i,
  // Network issues (transient, not bugs)
  /network error/i,
  /network issue/i,
  /fetch failed/i,
  /connection refused/i,
  /timeout/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  // Permission/access errors (operational, not bugs)
  /forbidden/i,
  /access denied/i,
];

/**
 * Check if an error is operational (user error) vs programmer error (bug).
 * Returns true for operational errors that should be filtered out.
 */
function isOperationalError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message;
  return OPERATIONAL_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

if (DSN) {
  Sentry.init({
    dsn: DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? "production",
    release: __CLI_VERSION__,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    shutdownTimeout: 500,
    initialScope: {
      tags: {
        app: "cli",
      },
    },
    // Filter out operational errors - only send programmer errors (bugs)
    beforeSend(event, hint) {
      const error = hint.originalException;
      if (isOperationalError(error)) {
        return null; // Drop operational errors
      }
      return event;
    },
  });

  Sentry.setContext("cli", {
    version: __CLI_VERSION__,
    command: process.argv.slice(2).join(" "),
  });

  Sentry.setContext("runtime", {
    node_version: process.version,
    os_platform: os.platform(),
    os_release: os.release(),
  });
}
