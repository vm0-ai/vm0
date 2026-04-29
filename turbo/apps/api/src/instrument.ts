import { propagation } from "@opentelemetry/api";
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

const HTTP_ROUTE_BAGGAGE_KEY = "http.route";

// PgInstrumentation defaults the span name to "pg.query:SELECT <db>" — too
// generic to slice on. Pull the operation + first referenced table out of
// the parameterized SQL so RED metrics can group by a readable label.
// `db.statement` still carries the full parameterized SQL for cases where
// the exact template matters.
function deriveSqlSpanName(sql: string): string | null {
  const trimmed = sql.trim();
  const opMatch = /^(SELECT|INSERT|UPDATE|DELETE|WITH|MERGE)/i.exec(trimmed);
  if (!opMatch?.[1]) {
    return null;
  }
  const op = opMatch[1].toUpperCase();
  const tableMatch =
    /\b(?:FROM|INTO|UPDATE|JOIN)\s+(?:ONLY\s+)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i.exec(
      trimmed,
    );
  return tableMatch ? `${op} ${tableMatch[1]}` : op;
}

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
  // OTel only runs in deployed environments — VERCEL_GIT_COMMIT_SHA is
  // injected by Vercel and absent during `pnpm dev` / vitest. Without it
  // we don't have a useful service.version anyway.
  const serviceVersion = env("VERCEL_GIT_COMMIT_SHA");
  if (!serviceVersion) {
    return;
  }

  // Copy the matched route template from baggage onto every db span the
  // hono request triggers, and rename the span to <op> <table> so RED
  // dashboards group on something readable. The full parameterized SQL
  // is still on `db.statement` for fine-grained slicing.
  const pgInstrumentation = new PgInstrumentation({
    ignoreConnectSpans: true,
    requestHook: (span, info) => {
      const route = propagation
        .getActiveBaggage()
        ?.getEntry(HTTP_ROUTE_BAGGAGE_KEY)?.value;
      if (route) {
        span.setAttribute("http.route", route);
      }
      const derived = deriveSqlSpanName(info.query.text);
      if (derived) {
        span.updateName(derived);
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

  // We run our own OTel pipeline (@vercel/otel + @hono/otel + PgInstrumentation
  // exporting to Axiom). @sentry/node v10 layers Sentry's own instrumentations
  // on top of whatever tracer it sees, so without these opt-outs every request
  // got a duplicate SERVER span and every outgoing request received both
  // Sentry's `sentry-trace`/`baggage` and OTel's `traceparent` headers. The
  // configuration below matches Sentry's "Using Your Existing OpenTelemetry
  // Setup" guide:
  //   - `skipOpenTelemetrySetup: true` — don't let Sentry init its own OTel
  //     SDK; @vercel/otel already provides the tracer/exporter.
  //   - `httpIntegration({ spans: false, tracePropagation: false })` — keep
  //     Sentry's request isolation but stop it from creating SERVER spans or
  //     injecting Sentry trace headers on incoming requests.
  //   - `nativeNodeFetchIntegration({ tracePropagation: false })` — stop
  //     Sentry from injecting trace headers on outgoing fetch; span emission
  //     is already off because skipOpenTelemetrySetup flips its default.
  // Sentry error capture (`captureException`) is unaffected by any of these.
  // Reference: https://docs.sentry.io/platforms/javascript/guides/hono/opentelemetry/custom-setup/
  init({
    dsn,
    environment: env("VERCEL_ENV"),
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
