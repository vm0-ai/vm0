import { getMeter, isMetricsEnabled, getRunnerLabel } from "./provider";

const meter = getMeter("vm0-runner");

// Runner operation counters
const runnerOperationTotal = meter.createCounter("runner_operation_total", {
  description: "Total number of runner operations",
});

const runnerOperationErrorsTotal = meter.createCounter(
  "runner_operation_errors_total",
  {
    description: "Total number of runner operation errors",
  },
);

// Runner operation histogram
const runnerOperationDuration = meter.createHistogram(
  "runner_operation_duration_ms",
  {
    description: "Runner operation duration in milliseconds",
    unit: "ms",
  },
);

// Sandbox operation counters
const sandboxOperationTotal = meter.createCounter("sandbox_operation_total", {
  description: "Total number of sandbox operations",
});

const sandboxOperationErrorsTotal = meter.createCounter(
  "sandbox_operation_errors_total",
  {
    description: "Total number of sandbox operation errors",
  },
);

// Sandbox operation histogram
const sandboxOperationDuration = meter.createHistogram(
  "sandbox_operation_duration_ms",
  {
    description: "Sandbox operation duration in milliseconds",
    unit: "ms",
  },
);

export function recordRunnerOperation(attrs: {
  actionType: string;
  durationMs: number;
  success: boolean;
}): void {
  if (!isMetricsEnabled()) return;

  const labels = {
    action_type: attrs.actionType,
    runner_label: getRunnerLabel(),
  };

  // Always increment total counter
  runnerOperationTotal.add(1, labels);

  // Increment error counter if failed
  if (!attrs.success) {
    runnerOperationErrorsTotal.add(1, labels);
  }

  // Always record duration histogram
  runnerOperationDuration.record(attrs.durationMs, {
    ...labels,
    success: String(attrs.success),
  });
}

export function recordSandboxOperation(attrs: {
  actionType: string;
  durationMs: number;
  success: boolean;
}): void {
  if (!isMetricsEnabled()) return;

  const labels = {
    sandbox_type: "runner",
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
