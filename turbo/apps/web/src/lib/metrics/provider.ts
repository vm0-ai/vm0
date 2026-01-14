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
let sandboxMeterProvider: MeterProvider | null = null;
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
  const exportIntervalMillis = config.exportIntervalMs ?? 30000;

  // API metrics exporter (api-metrics-{env})
  const apiExporter = new OTLPMetricExporter({
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
        exporter: apiExporter,
        exportIntervalMillis,
      }),
    ],
  });

  metrics.setGlobalMeterProvider(meterProvider);

  // Sandbox internal metrics exporter (sandbox-metric-{env})
  const sandboxExporter = new OTLPMetricExporter({
    url: "https://api.axiom.co/v1/metrics",
    headers: {
      Authorization: `Bearer ${config.axiomToken}`,
      "X-Axiom-Dataset": `sandbox-metric-${env}`,
    },
  });

  sandboxMeterProvider = new MeterProvider({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: `${config.serviceName}-sandbox`,
      "deployment.environment": env,
    }),
    readers: [
      new PeriodicExportingMetricReader({
        exporter: sandboxExporter,
        exportIntervalMillis,
      }),
    ],
  });

  enabled = true;
  console.log(`[metrics] initialized for ${config.serviceName} (${env})`);
}

export function isMetricsEnabled(): boolean {
  return enabled;
}

export function getMeter(name: string) {
  return metrics.getMeter(name);
}

export function getSandboxMeter(name: string) {
  if (!sandboxMeterProvider) {
    throw new Error("Sandbox metrics not initialized");
  }
  return sandboxMeterProvider.getMeter(name);
}

export async function flushMetrics(): Promise<void> {
  await Promise.all([
    meterProvider?.forceFlush(),
    sandboxMeterProvider?.forceFlush(),
  ]);
}

export async function shutdownMetrics(): Promise<void> {
  await Promise.all([
    meterProvider?.shutdown(),
    sandboxMeterProvider?.shutdown(),
  ]);
}
