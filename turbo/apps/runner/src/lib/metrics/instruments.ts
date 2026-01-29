// Sandbox context for telemetry API reporting
interface SandboxContext {
  apiUrl: string;
  runId: string;
  sandboxToken: string;
}

interface SandboxOpEntry {
  ts: string;
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
    await flushOpsWithContext(ctx, ops);
  }
}

/**
 * Flush pending operations to telemetry API
 */
async function flushOps(): Promise<void> {
  if (!sandboxContext || pendingOps.length === 0) return;

  const ctx = sandboxContext;
  const ops = pendingOps;
  pendingOps = [];
  oldestPendingTime = null;

  await flushOpsWithContext(ctx, ops);
}

/**
 * Flush given operations to telemetry API with provided context
 */
async function flushOpsWithContext(
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
        `[metrics] Failed to flush operations: HTTP ${response.status}`,
      );
    }
  } catch (err) {
    console.warn(`[metrics] Failed to flush operations: ${err}`);
  }
}

/**
 * Record a metric via telemetry API (no prefix)
 * Collects in memory, auto-flushes if oldest pending op exceeds threshold
 */
export function recordOperation(attrs: {
  actionType: string;
  durationMs: number;
  success: boolean;
}): void {
  if (!sandboxContext) {
    // Context not set - this is expected before job starts or after job ends
    return;
  }

  const now = Date.now();

  // Check if we should flush before adding new op
  if (oldestPendingTime && now - oldestPendingTime >= FLUSH_THRESHOLD_MS) {
    flushOps().catch(() => {
      // Ignore - metrics are best-effort
    });
  }

  // Track oldest pending time
  if (oldestPendingTime === null) {
    oldestPendingTime = now;
  }

  pendingOps.push({
    ts: new Date().toISOString(),
    action_type: attrs.actionType,
    duration_ms: attrs.durationMs,
    success: attrs.success,
  });
}
