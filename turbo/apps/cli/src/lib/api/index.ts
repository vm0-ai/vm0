// Core types (only export what's actually used)
export type { ApiError, GetComposeResponse, RunResult } from "./core/types";

// HTTP utilities (only export what's actually used)
export { httpGet } from "./core/http";

// Domain modules - Composes
export {
  getComposeByName,
  getComposeById,
  getComposeVersion,
  createOrUpdateCompose,
} from "./domains/composes";

// Domain modules - Runs
export { createRun, getEvents } from "./domains/runs";

// Domain modules - Sessions
export { getSession, getCheckpoint } from "./domains/sessions";

// Domain modules - Scopes
export { getScope, createScope, updateScope } from "./domains/scopes";

// Domain modules - Storages
export {
  prepareStorage,
  commitStorage,
  getStorageDownload,
  listStorages,
} from "./domains/storages";

// Domain modules - Schedules
export {
  deploySchedule,
  listSchedules,
  getScheduleByName,
  deleteSchedule,
  enableSchedule,
  disableSchedule,
  listScheduleRuns,
} from "./domains/schedules";

// Domain modules - Credentials
export {
  listCredentials,
  getCredential,
  setCredential,
  deleteCredential,
} from "./domains/credentials";

// Domain modules - Model Providers
export {
  listModelProviders,
  upsertModelProvider,
  checkModelProviderCredential,
  deleteModelProvider,
  convertModelProviderCredential,
  setModelProviderDefault,
} from "./domains/model-providers";

// Domain modules - Usage
export { getUsage } from "./domains/usage";
