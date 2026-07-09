const DEFAULT_RESTART_DELAYS_MS = [1_000, 5_000, 30_000] as const;
const DEFAULT_STABLE_UPTIME_MS = 60_000;

interface PluginRestartPolicyOptions {
  readonly delaysMs?: readonly number[];
  readonly stableUptimeMs?: number;
  readonly now?: () => number;
}

/**
 * Bounded exponential-backoff restart policy for desktop plugin MCP server
 * processes. Shared by plugin managers so every plugin runtime recovers from
 * crashes the same way: retry with increasing delays, give up after the
 * budget is exhausted, and forget past failures once a process has stayed up
 * for a stable window.
 */
export class PluginRestartPolicy {
  private readonly delaysMs: readonly number[];
  private readonly stableUptimeMs: number;
  private readonly now: () => number;
  private attempts = 0;
  private startedAtMs: number | null = null;

  constructor(options: PluginRestartPolicyOptions = {}) {
    this.delaysMs = options.delaysMs ?? DEFAULT_RESTART_DELAYS_MS;
    this.stableUptimeMs = options.stableUptimeMs ?? DEFAULT_STABLE_UPTIME_MS;
    this.now = options.now ?? Date.now;
  }

  notifyStarted(): void {
    this.startedAtMs = this.now();
  }

  nextDelayMs(): number | null {
    if (
      this.startedAtMs !== null &&
      this.now() - this.startedAtMs >= this.stableUptimeMs
    ) {
      this.attempts = 0;
    }
    this.startedAtMs = null;
    const delayMs = this.delaysMs[this.attempts];
    if (delayMs === undefined) {
      return null;
    }
    this.attempts += 1;
    return delayMs;
  }

  reset(): void {
    this.attempts = 0;
    this.startedAtMs = null;
  }
}
