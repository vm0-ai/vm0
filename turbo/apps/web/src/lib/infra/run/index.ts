/**
 * Run service module
 * Handles creation and resumption of agent runs
 */

export {
  insertRunRecord,
  buildAndDispatchRun,
  loadCompose,
  markRunFailed,
  registerCallbacks,
  isRunDispatchError,
  type RunDispatchError,
  type CreateRunParams,
  type CreateRunRecordResult,
} from "./run-service";
