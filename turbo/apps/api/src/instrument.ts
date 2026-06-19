import { register } from "node:module";

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import {
  httpIntegration,
  init,
  nativeNodeFetchIntegration,
} from "@sentry/node";
import { registerOTel } from "@vercel/otel";

import { env } from "./lib/env";

const OTEL_SERVICE_NAME = "vm0-api";

function buildAxiomTraceExporter(): OTLPTraceExporter {
  return new OTLPTraceExporter({
    url: "https://api.axiom.co/v1/traces",
    headers: {
      authorization: `Bearer ${env("AXIOM_TOKEN_TELEMETRY")}`,
      "x-axiom-dataset": `vm0-traces-${env("AXIOM_DATASET_SUFFIX")}`,
    },
  });
}

function setupOpenTelemetry() {
  // The api ships as a single bundled ESM file, so the require/import hook
  // can't intercept `pg` on its own. `pg` is kept external (see vite.config.ts)
  // and this loader hook lets `@opentelemetry/instrumentation-pg` patch it on
  // import — the standard ESM instrumentation mechanism for Node >= 20.6.
  // Must run before the first `import "pg"` (db.ts loads pg lazily, after this).
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

  registerOTel({
    serviceName: OTEL_SERVICE_NAME,
    attributes: { [ATTR_SERVICE_VERSION]: env("GIT_COMMIT_SHA") },
    traceExporter: buildAxiomTraceExporter(),
    instrumentations: [new PgInstrumentation()],
  });
}

function setupSentry() {
  const dsn = env("SENTRY_DSN");
  const environment = env("ENV");

  if (!dsn || environment !== "production") {
    return;
  }

  const release = env("GIT_COMMIT_SHA");

  init({
    dsn,
    environment,
    initialScope: {
      tags: {
        app: "api",
      },
    },
    integrations: [
      httpIntegration({ spans: false, tracePropagation: false }),
      nativeNodeFetchIntegration({ tracePropagation: false }),
    ],
    release,
    sendDefaultPii: false,
    shutdownTimeout: 500,
    skipOpenTelemetrySetup: true,
    tracesSampleRate: 0,
  });
}

function instrument() {
  setupOpenTelemetry();
  setupSentry();
}

instrument();
