import { getMeter, isMetricsEnabled, getRunnerLabel } from "./provider";
import type { Counter, Histogram } from "@opentelemetry/api";

// Lazy-initialized instruments (created after initMetrics is called)
let runnerOperationTotal: Counter | null = null;
let runnerOperationErrorsTotal: Counter | null = null;
let runnerOperationDuration: Histogram | null = null;
let sandboxOperationTotal: Counter | null = null;
let sandboxOperationErrorsTotal: Counter | null = null;
let sandboxOperationDuration: Histogram | null = null;

function getRunnerInstruments() {
  if (!runnerOperationTotal) {
    const meter = getMeter("vm0-runner");
    runnerOperationTotal = meter.createCounter("runner_operation_total", {
      description: "Total number of runner operations",
    });
    runnerOperationErrorsTotal = meter.createCounter(
      "runner_operation_errors_total",
      {
        description: "Total number of runner operation errors",
      },
    );
    runnerOperationDuration = meter.createHistogram(
      "runner_operation_duration_ms",
      {
        description: "Runner operation duration in milliseconds",
        unit: "ms",
      },
    );
  }
  return {
    runnerOperationTotal: runnerOperationTotal!,
    runnerOperationErrorsTotal: runnerOperationErrorsTotal!,
    runnerOperationDuration: runnerOperationDuration!,
  };
}

function getSandboxInstruments() {
  if (!sandboxOperationTotal) {
    const meter = getMeter("vm0-runner");
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

export function recordRunnerOperation(attrs: {
  actionType: string;
  durationMs: number;
  success: boolean;
}): void {
  if (!isMetricsEnabled()) return;

  const {
    runnerOperationTotal,
    runnerOperationErrorsTotal,
    runnerOperationDuration,
  } = getRunnerInstruments();

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

  const {
    sandboxOperationTotal,
    sandboxOperationErrorsTotal,
    sandboxOperationDuration,
  } = getSandboxInstruments();

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
