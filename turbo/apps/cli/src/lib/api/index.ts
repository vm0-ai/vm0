// Core types (only export what's actually used)
export type { RunResult } from "./core/types";

// Custom error class
export { ApiRequestError } from "./core/client-factory";

// HTTP utilities (only export what's actually used)

// Domain modules - Composes
export {
  getComposeByName,
  getComposeById,
  getComposeVersion,
  createOrUpdateCompose,
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

// Domain modules - Storages
export {
  prepareStorage,
  commitStorage,
  getStorageDownload,
  listStorages,
} from "./domains/storages";

// Domain modules - Zero User Preferences
export {
  getZeroUserPreferences,
  updateZeroUserPreferences,
} from "./domains/zero-user-preferences";

// Domain modules - Skills
export { resolveSkills } from "./domains/skills";

// Domain modules - Zero Organizations
export {
  getZeroOrg,
  updateZeroOrg,
  listZeroOrgs,
  getZeroOrgMembers,
  inviteZeroOrgMember,
  removeZeroOrgMember,
  leaveZeroOrg,
  deleteZeroOrg,
  switchZeroOrg,
} from "./domains/zero-orgs";

// Domain modules - Zero Secrets
export {
  listZeroSecrets,
  setZeroSecret,
  deleteZeroSecret,
} from "./domains/zero-secrets";

// Domain modules - Zero Variables
export {
  listZeroVariables,
  setZeroVariable,
  deleteZeroVariable,
} from "./domains/zero-variables";

// Domain modules - Zero Org Secrets
export {
  listZeroOrgSecrets,
  setZeroOrgSecret,
  deleteZeroOrgSecret,
} from "./domains/zero-org-secrets";

// Domain modules - Zero Org Variables
export {
  listZeroOrgVariables,
  setZeroOrgVariable,
  deleteZeroOrgVariable,
} from "./domains/zero-org-variables";

// Domain modules - Zero Org Model Providers
export {
  listZeroOrgModelProviders,
  upsertZeroOrgModelProvider,
  deleteZeroOrgModelProvider,
  setZeroOrgModelProviderDefault,
  updateZeroOrgModelProviderModel,
} from "./domains/zero-org-model-providers";

// Domain modules - Zero Agents
export {
  createZeroAgent,
  listZeroAgents,
  getZeroAgent,
  updateZeroAgent,
  deleteZeroAgent,
  getZeroAgentInstructions,
  updateZeroAgentInstructions,
} from "./domains/zero-agents";

// Domain modules - Zero Connectors
export {
  listZeroConnectors,
  getZeroConnector,
  deleteZeroConnector,
  createZeroConnectorSession,
  getZeroConnectorSession,
  createZeroComputerConnector,
  deleteZeroComputerConnector,
} from "./domains/zero-connectors";

// Domain modules - Integrations Slack
export { sendSlackMessage } from "./domains/integrations-slack";

// Domain modules - Zero Schedules
export {
  deployZeroSchedule,
  listZeroSchedules,
  deleteZeroSchedule,
  enableZeroSchedule,
  disableZeroSchedule,
  resolveZeroScheduleByAgent,
} from "./domains/zero-schedules";
