import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { registerOTel } from "@vercel/otel";

const serviceVersion =
  process.env.OTEL_SERVICE_VERSION ?? process.env.VERCEL_GIT_COMMIT_SHA;

const hasOtlpEndpoint = Boolean(
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
);

registerOTel({
  serviceName: process.env.OTEL_SERVICE_NAME ?? "vm0-api",
  attributes: serviceVersion ? { [ATTR_SERVICE_VERSION]: serviceVersion } : {},
  instrumentations: [
    new PgInstrumentation({
      ignoreConnectSpans: true,
      requireParentSpan: true,
    }),
  ],
  traceExporter: hasOtlpEndpoint ? new OTLPTraceExporter() : "auto",
});
