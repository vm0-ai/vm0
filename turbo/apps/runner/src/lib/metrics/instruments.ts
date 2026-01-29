import { getMeter, isMetricsEnabled, getRunnerLabel } from "./provider";
import type { Counter, Histogram } from "@opentelemetry/api";

// Lazy-initialized instruments (created after initMetrics is called)
let runnerOperationTotal: Counter | null = null;
let runnerOperationErrorsTotal: Counter | null = null;
let runnerOperationDuration: Histogram | null = null;

// Sandbox context for telemetry API reporting
interface SandboxContext {
  apiUrl: string;
  runId: string;
  sandboxToken: string;
}

interface SandboxOpEntry {
  action_type: string;
  duration_ms: number;
  success: boolean;
}

// Flush threshold: if oldest pending op is older than this, flush (same as sandbox telemetry interval)
const FLUSH_THRESHOLD_MS = 30000;

let sandboxContext: SandboxContext | null = null;
let pendingOps: SandboxOpEntry[] = [];
let oldestPendingTime: number | null = null;

/**
 * Set the sandbox context for metrics reporting via telemetry API
 */
export function setSandboxContext(ctx: SandboxContext): void {
  sandboxContext = ctx;
  pendingOps = [];
  oldestPendingTime = null;
}

/**
 * Flush pending sandbox operations to telemetry API and clear context
 * Call after job completion (final flush)
 */
export async function clearSandboxContext(): Promise<void> {
  // Clear context first to reject any new operations during flush
  const ctx = sandboxContext;
  const ops = pendingOps;

  sandboxContext = null;
  pendingOps = [];
  oldestPendingTime = null;

  // Final flush with captured state
  if (ctx && ops.length > 0) {
    await flushSandboxOpsWithContext(ctx, ops);
  }
}

/**
 * Flush pending sandbox operations to telemetry API
 */
async function flushSandboxOps(): Promise<void> {
  if (!sandboxContext || pendingOps.length === 0) return;

  const ctx = sandboxContext;
  const ops = pendingOps;
  pendingOps = [];
  oldestPendingTime = null;

  await flushSandboxOpsWithContext(ctx, ops);
}

/**
 * Flush given operations to telemetry API with provided context
 */
async function flushSandboxOpsWithContext(
  ctx: SandboxContext,
  ops: SandboxOpEntry[],
): Promise<void> {
  const { apiUrl, runId, sandboxToken } = ctx;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${sandboxToken}`,
    "Content-Type": "application/json",
  };

  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }

  try {
    const response = await fetch(`${apiUrl}/api/webhooks/agent/telemetry`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        runId,
        sandboxOperations: ops,
      }),
    });

    // Always consume response body to allow connection reuse
    await response.text();

    if (!response.ok) {
      console.warn(
        `[metrics] Failed to flush sandbox operations: HTTP ${response.status}`,
      );
    }
  } catch (err) {
    console.warn(`[metrics] Failed to flush sandbox operations: ${err}`);
  }
}

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

/**
 * Record a sandbox operation metric
 * Collects in memory, auto-flushes if oldest pending op exceeds threshold
 */
export function recordSandboxOperation(attrs: {
  actionType: string;
  durationMs: number;
  success: boolean;
}): void {
  if (!isMetricsEnabled()) return;
  if (!sandboxContext) {
    console.warn(
      `[metrics] Cannot record sandbox operation: context not set (action=${attrs.actionType})`,
    );
    return;
  }

  const now = Date.now();

  // Check if we should flush before adding new op
  if (oldestPendingTime && now - oldestPendingTime >= FLUSH_THRESHOLD_MS) {
    flushSandboxOps().catch(() => {
      // Ignore - metrics are best-effort
    });
  }

  // Track oldest pending time
  if (oldestPendingTime === null) {
    oldestPendingTime = now;
  }

  pendingOps.push({
    action_type: attrs.actionType,
    duration_ms: attrs.durationMs,
    success: attrs.success,
  });
}
