/**
 * Run service module
 * Handles creation and resumption of agent runs
 */

export {
  validateAgentSession,
  startRun,
  createRun,
  createRunRecord,
  buildAndDispatchRun,
  resolveStartRunCompose,
  isRunDispatchError,
  type RunDispatchError,
  type CreateRunParams,
  type CreateRunResult,
} from "./run-service";
