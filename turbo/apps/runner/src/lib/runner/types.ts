/**
 * Runner mode for lifecycle management
 *
 * State transitions:
 * - running -> stopping (SIGTERM/SIGINT received)
 * - running -> draining (SIGUSR1 received)
 * - draining -> stopping (all jobs completed)
 * - stopping -> stopped (cleanup completed)
 */
export type RunnerMode = "running" | "draining" | "stopping" | "stopped";

/**
 * Internal runner state shared across modules
 */
export interface RunnerState {
  mode: RunnerMode;
  activeRuns: Set<string>;
  jobPromises: Set<Promise<void>>;
  startedAt: Date;
}

/**
 * Runner status for external monitoring (written to status.json)
 * Used by deployment tools (Ansible) to track drain progress
 */
export interface RunnerStatus {
  mode: RunnerMode;
  active_runs: number;
  active_run_ids: string[];
  started_at: string;
  updated_at: string;
}

/**
 * Resources initialized during runner setup
 */
export interface RunnerResources {
  proxyEnabled: boolean;
  proxyPort: number;
}
