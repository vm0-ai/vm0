// Core types (only export what's actually used)
export type { RunResult } from "./core/types";

// Custom error class
export { ApiRequestError } from "./core/client-factory";

// HTTP utilities (only export what's actually used)

// Domain modules - Composes
export {
  getComposeByName,
  getComposeById,
  resolveCompose,
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
  getZeroAgentUserConnectors,
} from "./domains/zero-agents";

// Domain modules - Zero Skills (org-level)
export {
  listSkills,
  createSkill,
  getSkill,
  updateSkill,
  deleteSkill,
} from "./domains/zero-skills";

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
export {
  sendSlackMessage,
  initSlackFileUpload,
  completeSlackFileUpload,
} from "./domains/integrations-slack";

// Domain modules - Zero Schedules
export {
  deployZeroSchedule,
  listZeroSchedules,
  deleteZeroSchedule,
  enableZeroSchedule,
  disableZeroSchedule,
  resolveZeroScheduleByAgent,
} from "./domains/zero-schedules";

// Domain modules - Zero Runs
export {
  createZeroRun,
  getZeroRun,
  getZeroRunAgentEvents,
} from "./domains/zero-runs";

// Domain modules - Zero Logs
export { listZeroLogs, searchZeroLogs } from "./domains/zero-logs";

// Domain modules - Logs
export {
  getSystemLog,
  getMetrics,
  getAgentEvents,
  getNetworkLogs,
  searchLogs,
  type RunEvent,
  type TelemetryMetric,
  type NetworkLogEntry,
  type LogsSearchResponse,
} from "./domains/logs";

// Domain modules - Zero Developer Support
export {
  requestDeveloperSupportConsent,
  submitDeveloperSupport,
} from "./domains/zero-developer-support";

// Domain modules - Zero Computer Use
export {
  registerComputerUseHost,
  unregisterComputerUseHost,
  getComputerUseHost,
} from "./domains/zero-computer-use";

// Domain modules - Phone Calls
export {
  createPhoneCall,
  listPhoneCalls,
  getPhoneCallDetail,
  type PhoneCall,
  type TranscriptEntry,
} from "./domains/phone-calls";

// Domain modules - Zero Voice Chat Context
export {
  getVoiceChatContextEvents,
  appendVoiceChatContextEvent,
} from "./domains/zero-voice-chat-context";

// Domain modules - Zero Voice Chat Prepare
export { completeVoiceChatPreparation } from "./domains/zero-voice-chat-prepare";
