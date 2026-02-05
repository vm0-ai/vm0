// Sentry instrumentation - must be imported before any other modules
import * as Sentry from "@sentry/node";
import * as os from "node:os";

declare const __CLI_VERSION__: string;

const TELEMETRY_DISABLED = process.env.VM0_TELEMETRY === "false";
const PRODUCTION_DSN =
  "https://268d9b4cd051531805af76a5b3934dca@o4510583739777024.ingest.us.sentry.io/4510832047947776";
const DSN = process.env.SENTRY_DSN || PRODUCTION_DSN;

if (!TELEMETRY_DISABLED && DSN) {
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
