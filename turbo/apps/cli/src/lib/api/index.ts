// Core types (only export what's actually used)
export type { ApiError, RunResult } from "./core/types";

// Custom error class
export { ApiRequestError } from "./core/client-factory";

// HTTP utilities (only export what's actually used)
export { httpGet } from "./core/http";

// Domain modules - Composes
export {
  getComposeByName,
  getComposeById,
  getComposeVersion,
  createOrUpdateCompose,
  deleteCompose,
} from "./domains/composes";

// Domain modules - Runs
export {
  createRun,
  getEvents,
  listRuns,
  cancelRun,
  getRunQueue,
} from "./domains/runs";

// Domain modules - Sessions
export { getSession, getCheckpoint } from "./domains/sessions";

// Domain modules - Organizations
export {
  getOrg,
  updateOrg,
  getOrgMembers,
  inviteOrgMember,
  removeOrgMember,
  leaveOrg,
  listOrgs,
} from "./domains/orgs";

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

// Domain modules - Secrets
export {
  listSecrets,
  getSecret,
  setSecret,
  deleteSecret,
} from "./domains/secrets";

// Domain modules - Variables
export {
  listVariables,
  getVariable,
  setVariable,
  deleteVariable,
} from "./domains/variables";

// Domain modules - Model Providers
export {
  listModelProviders,
  upsertModelProvider,
  checkModelProviderSecret,
  deleteModelProvider,
  setModelProviderDefault,
  updateModelProviderModel,
} from "./domains/model-providers";

// Domain modules - Connectors
export {
  listConnectors,
  deleteConnector,
  getConnector,
} from "./domains/connectors";

// Domain modules - Usage
export { getUsage } from "./domains/usage";

// Domain modules - User Preferences
export {
  getUserPreferences,
  updateUserPreferences,
} from "./domains/user-preferences";

// Domain modules - Skills
export { resolveSkills } from "./domains/skills";
