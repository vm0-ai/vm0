import { writeFileSync } from "fs";
import type { RunnerMode, RunnerState, RunnerStatus } from "./types.js";
import { createLogger } from "../logger.js";

const logger = createLogger("Runner");

/**
 * Write runner status to a JSON file for external monitoring.
 * Used by deployment tools (Ansible) to track drain progress.
 */
function writeStatusFile(
  statusFilePath: string,
  mode: RunnerMode,
  activeRuns: Set<string>,
  startedAt: Date,
): void {
  const status: RunnerStatus = {
    mode,
    active_runs: activeRuns.size,
    active_run_ids: Array.from(activeRuns),
    started_at: startedAt.toISOString(),
    updated_at: new Date().toISOString(),
  };

  try {
    writeFileSync(statusFilePath, JSON.stringify(status, null, 2));
  } catch (err) {
    // Non-fatal: log and continue
    logger.error(
      `Failed to write status file: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

/**
 * Create a status updater function bound to state and path
 */
export function createStatusUpdater(
  statusFilePath: string,
  state: RunnerState,
): () => void {
  return () => {
    writeStatusFile(
      statusFilePath,
      state.mode,
      state.activeRuns,
      state.startedAt,
    );
  };
}
