import { z } from "zod";

/**
 * Runner mode for lifecycle management
 *
 * State transitions:
 * - running -> stopping (SIGTERM/SIGINT received)
 * - running -> draining (SIGUSR1 received)
 * - draining -> stopping (all jobs completed)
 * - stopping -> stopped (cleanup completed)
 */
const RunnerModeSchema = z.enum(["running", "draining", "stopping", "stopped"]);
export type RunnerMode = z.infer<typeof RunnerModeSchema>;

/**
 * Runner status for external monitoring (written to status.json)
 * Used by deployment tools (Ansible) to track drain progress
 */
export const RunnerStatusSchema = z.object({
  mode: RunnerModeSchema,
  active_runs: z.number(),
  active_run_ids: z.array(z.string()),
  started_at: z.string(),
  updated_at: z.string(),
});
export type RunnerStatus = z.infer<typeof RunnerStatusSchema>;

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
 * Resources initialized during runner setup
 */
export interface RunnerResources {
  proxyEnabled: boolean;
  proxyPort: number;
}
