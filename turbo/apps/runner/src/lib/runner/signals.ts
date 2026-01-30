import type { RunnerState } from "./types.js";
import { createLogger } from "../logger.js";

const logger = createLogger("Runner");

interface SignalHandlers {
  onShutdown: () => void;
  onDrain: () => void;
  updateStatus: () => void;
}

/**
 * Set up signal handlers for graceful shutdown and drain mode
 */
export function setupSignalHandlers(
  state: RunnerState,
  handlers: SignalHandlers,
): void {
  // Handle graceful shutdown (SIGINT, SIGTERM)
  process.on("SIGINT", () => {
    logger.log("\nShutting down...");
    handlers.onShutdown();
    state.mode = "stopped";
    handlers.updateStatus();
  });

  process.on("SIGTERM", () => {
    logger.log("\nShutting down...");
    handlers.onShutdown();
    state.mode = "stopped";
    handlers.updateStatus();
  });

  // Handle SIGUSR1 for maintenance/drain mode
  // When received, stop polling for new jobs but continue executing active jobs
  process.on("SIGUSR1", () => {
    if (state.mode === "running") {
      logger.log("\n[Maintenance] Entering drain mode...");
      logger.log(
        `[Maintenance] Active jobs: ${state.activeRuns.size} (will wait for completion)`,
      );
      state.mode = "draining";
      handlers.updateStatus();
      handlers.onDrain();
    }
  });
}
