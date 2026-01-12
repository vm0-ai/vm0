/**
 * Run service module
 * Handles creation and resumption of agent runs
 */

export { runService, calculateSessionHistoryPath } from "./run-service";
export type { ExecutionContext, ResumeSession } from "./types";

// Executor exports
export { e2bExecutor, runnerExecutor } from "./executors";
export type { PreparedContext, ExecutorResult, Executor } from "./executors";

// Context preparation exports
export {
  prepareForExecution,
  extractWorkingDir,
  extractCliAgentType,
  resolveRunnerGroup,
} from "./context";
