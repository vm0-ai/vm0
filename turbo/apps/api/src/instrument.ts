import { propagation } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { init } from "@sentry/node";
import { registerOTel } from "@vercel/otel";

import { env } from "./lib/env";

const OTEL_SERVICE_NAME = "vm0-api";

const HTTP_ROUTE_BAGGAGE_KEY = "http.route";

function buildAxiomTraceExporter(): OTLPTraceExporter | "auto" {
  const token = env("AXIOM_TOKEN_TELEMETRY");
  const suffix = env("AXIOM_DATASET_SUFFIX");
  if (!token || !suffix) {
    return "auto";
  }
  return new OTLPTraceExporter({
    url: "https://api.axiom.co/v1/traces",
    headers: {
      authorization: `Bearer ${token}`,
      "x-axiom-dataset": `vm0-traces-${suffix}`,
    },
  });
}

function setupOpenTelemetry() {
  const serviceVersion = env("VERCEL_GIT_COMMIT_SHA");
  if (!serviceVersion) {
    return;
  }

  // Copy the matched route template from baggage onto every db span the
  // hono request triggers. Lets dashboards slice "SQL P99 by URL template"
  // without joining on trace_id.
  const pgInstrumentation = new PgInstrumentation({
    ignoreConnectSpans: true,
    requestHook: (span) => {
      const route = propagation
        .getActiveBaggage()
        ?.getEntry(HTTP_ROUTE_BAGGAGE_KEY)?.value;
      if (route) {
        span.setAttribute("http.route", route);
      }
    },
  });

  registerOTel({
    serviceName: OTEL_SERVICE_NAME,
    attributes: { [ATTR_SERVICE_VERSION]: serviceVersion },
    instrumentations: [pgInstrumentation],
    traceExporter: buildAxiomTraceExporter(),
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
