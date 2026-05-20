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
  type CreateRunParams,
  type CreateRunRecordResult,
} from "./run-service";
