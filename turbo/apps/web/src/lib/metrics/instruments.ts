import { getMeter, getSandboxMeter, isMetricsEnabled } from "./provider";
import type { Counter, Histogram } from "@opentelemetry/api";

// Lazy-initialized instruments (created after initMetrics is called)
let httpRequestTotal: Counter | null = null;
let httpRequestErrorsTotal: Counter | null = null;
let httpRequestDuration: Histogram | null = null;
let sandboxOperationTotal: Counter | null = null;
let sandboxOperationErrorsTotal: Counter | null = null;
let sandboxOperationDuration: Histogram | null = null;

// Sandbox internal operation instruments (go to sandbox-metric-{env} dataset)
let sandboxInternalOperationTotal: Counter | null = null;
let sandboxInternalOperationErrorsTotal: Counter | null = null;
let sandboxInternalOperationDuration: Histogram | null = null;

function getApiInstruments() {
  if (!httpRequestTotal) {
    const meter = getMeter("vm0-web");
    httpRequestTotal = meter.createCounter("http_request_total", {
      description: "Total number of HTTP requests",
    });
    httpRequestErrorsTotal = meter.createCounter("http_request_errors_total", {
      description: "Total number of HTTP request errors (4xx/5xx)",
    });
    httpRequestDuration = meter.createHistogram("http_request_duration_ms", {
      description: "HTTP request duration in milliseconds",
      unit: "ms",
    });
  }
  return {
    httpRequestTotal: httpRequestTotal!,
    httpRequestErrorsTotal: httpRequestErrorsTotal!,
    httpRequestDuration: httpRequestDuration!,
  };
}

function getSandboxInstruments() {
  if (!sandboxOperationTotal) {
    const meter = getMeter("vm0-web");
    sandboxOperationTotal = meter.createCounter("sandbox_operation_total", {
      description: "Total number of sandbox operations",
    });
    sandboxOperationErrorsTotal = meter.createCounter(
      "sandbox_operation_errors_total",
      {
        description: "Total number of sandbox operation errors",
      },
    );
    sandboxOperationDuration = meter.createHistogram(
      "sandbox_operation_duration_ms",
      {
        description: "Sandbox operation duration in milliseconds",
        unit: "ms",
      },
    );
  }
  return {
    sandboxOperationTotal: sandboxOperationTotal!,
    sandboxOperationErrorsTotal: sandboxOperationErrorsTotal!,
    sandboxOperationDuration: sandboxOperationDuration!,
  };
}

export function recordApiRequest(attrs: {
  method: string;
  pathTemplate: string;
  statusCode: number;
  host: string;
  durationMs: number;
}): void {
  if (!isMetricsEnabled()) return;

  const { httpRequestTotal, httpRequestErrorsTotal, httpRequestDuration } =
    getApiInstruments();

  const labels = {
    method: attrs.method,
    path_template: attrs.pathTemplate,
    host: attrs.host,
  };

  // Always increment total counter
  httpRequestTotal.add(1, labels);

  // Increment error counter if status >= 400
  if (attrs.statusCode >= 400) {
    httpRequestErrorsTotal.add(1, {
      ...labels,
      status_code: String(attrs.statusCode),
    });
  }

  // Always record duration histogram
  httpRequestDuration.record(attrs.durationMs, {
    ...labels,
    status_code: String(attrs.statusCode),
  });
}

export function recordSandboxOperation(attrs: {
  sandboxType: "runner" | "e2b";
  actionType: string;
  durationMs: number;
  success: boolean;
}): void {
  if (!isMetricsEnabled()) return;

  const {
    sandboxOperationTotal,
    sandboxOperationErrorsTotal,
    sandboxOperationDuration,
  } = getSandboxInstruments();

  const labels = {
    sandbox_type: attrs.sandboxType,
    action_type: attrs.actionType,
  };

  // Always increment total counter
  sandboxOperationTotal.add(1, labels);

  // Increment error counter if failed
  if (!attrs.success) {
    sandboxOperationErrorsTotal.add(1, labels);
  }

  // Always record duration histogram
  sandboxOperationDuration.record(attrs.durationMs, {
    ...labels,
    success: String(attrs.success),
  });
}

function getSandboxInternalInstruments() {
  if (!sandboxInternalOperationTotal) {
    const meter = getSandboxMeter("vm0-sandbox");
    sandboxInternalOperationTotal = meter.createCounter(
      "sandbox_internal_operation_total",
      {
        description: "Total number of sandbox internal operations",
      },
    );
    sandboxInternalOperationErrorsTotal = meter.createCounter(
      "sandbox_internal_operation_errors_total",
      {
        description: "Total number of sandbox internal operation errors",
      },
    );
    sandboxInternalOperationDuration = meter.createHistogram(
      "sandbox_internal_operation_duration_ms",
      {
        description: "Sandbox internal operation duration in milliseconds",
        unit: "ms",
      },
    );
  }
  return {
    sandboxInternalOperationTotal: sandboxInternalOperationTotal!,
    sandboxInternalOperationErrorsTotal: sandboxInternalOperationErrorsTotal!,
    sandboxInternalOperationDuration: sandboxInternalOperationDuration!,
  };
}

export function recordSandboxInternalOperation(attrs: {
  actionType: string;
  sandboxType: string;
  durationMs: number;
  success: boolean;
}): void {
  if (!isMetricsEnabled()) return;

  const {
    sandboxInternalOperationTotal,
    sandboxInternalOperationErrorsTotal,
    sandboxInternalOperationDuration,
  } = getSandboxInternalInstruments();

  const labels = {
    action_type: attrs.actionType,
    sandbox_type: attrs.sandboxType,
  };

  // Always increment total counter
  sandboxInternalOperationTotal.add(1, labels);

  // Increment error counter if failed
  if (!attrs.success) {
    sandboxInternalOperationErrorsTotal.add(1, labels);
  }

  // Always record duration histogram
  sandboxInternalOperationDuration.record(attrs.durationMs, labels);
}
