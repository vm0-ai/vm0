// Sentry instrumentation - must be imported before any other modules
import * as Sentry from "@sentry/node";
import * as os from "node:os";

declare const __CLI_VERSION__: string;

const TELEMETRY_DISABLED = process.env.VM0_TELEMETRY === "false";
// Disable Sentry in CI to avoid network-related hangs during CLI exit
const IS_CI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);
// Disable Sentry in development unless explicitly configured
const IS_DEV = process.env.NODE_ENV === "development";
const PRODUCTION_DSN =
  "https://268d9b4cd051531805af76a5b3934dca@o4510583739777024.ingest.us.sentry.io/4510832047947776";
// Only use production DSN in actual production (not dev, not CI)
// Developers can set SENTRY_DSN to test Sentry locally
const DSN = process.env.SENTRY_DSN || (IS_DEV ? undefined : PRODUCTION_DSN);

if (!TELEMETRY_DISABLED && !IS_CI && DSN) {
  Sentry.init({
    dsn: DSN,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    // Set a short shutdown timeout to avoid hanging on exit (default is 2000ms)
    shutdownTimeout: 500,
    environment: process.env.SENTRY_DSN ? "development" : "production",
    initialScope: {
      tags: {
        app: "cli",
      },
    },
  });

  // Set CLI-specific context
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

/**
 * Capture an exception to Sentry with optional extra context.
 * This is a no-op if telemetry is disabled.
 */
export function captureException(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  if (TELEMETRY_DISABLED) {
    return;
  }

  if (context) {
    Sentry.captureException(error, { extra: context });
  } else {
    Sentry.captureException(error);
  }
}
