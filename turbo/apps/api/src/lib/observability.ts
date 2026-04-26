import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  SimpleSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

export const telemetryServiceName = process.env.OTEL_SERVICE_NAME ?? "vm0-api";
export const telemetryServiceVersion =
  process.env.OTEL_SERVICE_VERSION ?? process.env.VERCEL_GIT_COMMIT_SHA;

let tracerProvider: NodeTracerProvider | undefined;

function shouldExportTraces(): boolean {
  return Boolean(
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  );
}

function createSpanProcessors(): SpanProcessor[] {
  if (!shouldExportTraces()) {
    return [];
  }

  return [new SimpleSpanProcessor(new OTLPTraceExporter())];
}

function initTelemetry(): NodeTracerProvider {
  if (tracerProvider) {
    return tracerProvider;
  }

  const serviceAttributes: Record<string, string> = {
    [ATTR_SERVICE_NAME]: telemetryServiceName,
  };
  if (telemetryServiceVersion) {
    serviceAttributes[ATTR_SERVICE_VERSION] = telemetryServiceVersion;
  }

  tracerProvider = new NodeTracerProvider({
    forceFlushTimeoutMillis: 1_000,
    resource: resourceFromAttributes(serviceAttributes),
    spanProcessors: createSpanProcessors(),
  });
  tracerProvider.register();

  registerInstrumentations({
    tracerProvider,
    instrumentations: [
      new PgInstrumentation({
        ignoreConnectSpans: true,
        requireParentSpan: true,
      }),
    ],
  });

  return tracerProvider;
}

async function flushTelemetry(): Promise<void> {
  await tracerProvider?.forceFlush();
}

export async function flushTelemetrySafely(): Promise<void> {
  try {
    await flushTelemetry();
  } catch (error) {
    console.warn("Failed to flush API telemetry", error);
  }
}

initTelemetry();
