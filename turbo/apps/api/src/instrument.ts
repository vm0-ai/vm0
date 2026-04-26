import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { init } from "@sentry/node";
import { registerOTel } from "@vercel/otel";

import { env } from "./lib/env";

const OTEL_SERVICE_NAME = "vm0-api";

function setupOpenTelemetry() {
  const serviceVersion = env("VERCEL_GIT_COMMIT_SHA");
  if (!serviceVersion) {
    return;
  }

  const pgInstrumentation = new PgInstrumentation({
    ignoreConnectSpans: true,
    requireParentSpan: true,
  });

  registerOTel({
    serviceName: OTEL_SERVICE_NAME,
    attributes: { [ATTR_SERVICE_VERSION]: serviceVersion },
    instrumentations: [pgInstrumentation],
    traceExporter: "auto",
  });
}

function setupSentry() {
  const dsn = env("SENTRY_DSN");
  const release = env("VERCEL_GIT_COMMIT_SHA");

  if (!dsn) {
    return;
  }

  init({
    dsn,
    environment: env("VERCEL_ENV"),
    initialScope: {
      tags: {
        app: "api",
      },
    },
    release,
    sendDefaultPii: false,
    shutdownTimeout: 500,
    tracesSampleRate: 0,
  });
}

function instrument() {
  setupOpenTelemetry();
  setupSentry();
}

instrument();
