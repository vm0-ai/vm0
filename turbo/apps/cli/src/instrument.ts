// Sentry instrumentation - must be imported before any other modules
import * as Sentry from "@sentry/node";
import * as os from "node:os";

declare const __CLI_VERSION__: string;

const TELEMETRY_DISABLED = process.env.VM0_TELEMETRY === "false";
const IS_CI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);
const DSN =
  "https://268d9b4cd051531805af76a5b3934dca@o4510583739777024.ingest.us.sentry.io/4510832047947776";

if (!TELEMETRY_DISABLED && !IS_CI) {
  Sentry.init({
    dsn: DSN,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    shutdownTimeout: 500,
    initialScope: {
      tags: {
        app: "cli",
      },
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

export { Sentry };
