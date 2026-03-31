/**
 * Run service module
 * Handles creation and resumption of agent runs
 */

export {
  validateAgentSession,
  startRun,
  createRunRecord,
  buildAndDispatchRun,
  resolveStartRunCompose,
  loadCompose,
  markRunFailed,
  registerCallbacks,
  isRunDispatchError,
  type RunDispatchError,
  type CreateRunParams,
  type CreateRunResult,
} from "./run-service";
