import { getMeter, isMetricsEnabled } from "./provider";

const meter = getMeter("vm0-web");

// API Metrics - Counters
const httpRequestTotal = meter.createCounter("http_request_total", {
  description: "Total number of HTTP requests",
});

const httpRequestErrorsTotal = meter.createCounter(
  "http_request_errors_total",
  {
    description: "Total number of HTTP request errors (4xx/5xx)",
  },
);

// API Metrics - Histogram
const httpRequestDuration = meter.createHistogram("http_request_duration_ms", {
  description: "HTTP request duration in milliseconds",
  unit: "ms",
});

// Sandbox Metrics - Counters
const sandboxOperationTotal = meter.createCounter("sandbox_operation_total", {
  description: "Total number of sandbox operations",
});

const sandboxOperationErrorsTotal = meter.createCounter(
  "sandbox_operation_errors_total",
  {
    description: "Total number of sandbox operation errors",
  },
);

// Sandbox Metrics - Histogram
const sandboxOperationDuration = meter.createHistogram(
  "sandbox_operation_duration_ms",
  {
    description: "Sandbox operation duration in milliseconds",
    unit: "ms",
  },
);

export function recordApiRequest(attrs: {
  method: string;
  pathTemplate: string;
  statusCode: number;
  host: string;
  durationMs: number;
}): void {
  if (!isMetricsEnabled()) return;

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
