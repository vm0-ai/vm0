import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { metrics } from "@opentelemetry/api";

interface MetricsConfig {
  serviceName: string;
  axiomToken?: string;
  environment?: "dev" | "prod";
  exportIntervalMs?: number;
}

let meterProvider: MeterProvider | null = null;
let initialized = false;
let enabled = false;

export function initMetrics(config: MetricsConfig): void {
  if (initialized) return;
  initialized = true;

  if (!config.axiomToken) {
    console.log("[metrics] AXIOM_TOKEN not configured, metrics disabled");
    return;
  }

  const env = config.environment ?? "dev";

  const exporter = new OTLPMetricExporter({
    url: "https://api.axiom.co/v1/metrics",
    headers: {
      Authorization: `Bearer ${config.axiomToken}`,
      "X-Axiom-Dataset": `api-metrics-${env}`,
    },
  });

  meterProvider = new MeterProvider({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: config.serviceName,
      "deployment.environment": env,
    }),
    readers: [
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: config.exportIntervalMs ?? 30000,
      }),
    ],
  });

  metrics.setGlobalMeterProvider(meterProvider);
  enabled = true;
  console.log(`[metrics] initialized for ${config.serviceName} (${env})`);
}

export function isMetricsEnabled(): boolean {
  return enabled;
}

export function getMeter(name: string) {
  return metrics.getMeter(name);
}

export async function flushMetrics(): Promise<void> {
  if (meterProvider) {
    await meterProvider.forceFlush();
  }
}

export async function shutdownMetrics(): Promise<void> {
  if (meterProvider) {
    await meterProvider.shutdown();
  }
}
