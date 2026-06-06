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

// Domain modules - Zero Billing
export {
  getZeroBillingStatus,
  createZeroCreditCheckout,
} from "./domains/zero-billing";

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
} from "./domains/zero-org-model-providers";

// Domain modules - Zero Model Policies
export { listZeroModelPolicies } from "./domains/zero-model-policies";

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
  listZeroUserPermissionGrants,
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
  searchZeroConnectors,
  connectZeroConnectorManualGrant,
} from "./domains/zero-connectors";

// Domain modules - Integrations Slack
export {
  sendSlackMessage,
  initSlackFileUpload,
  completeSlackFileUpload,
  downloadSlackFile,
} from "./domains/integrations-slack";

// Domain modules - Integrations Telegram
export {
  listTelegramBots,
  sendTelegramMessage,
  downloadTelegramFile,
  initTelegramFileUpload,
  completeTelegramFileUpload,
} from "./domains/integrations-telegram";

// Domain modules - Integrations GitHub
export {
  downloadGithubFile,
  initGithubFileUpload,
  completeGithubFileUpload,
  getGithubInstallation,
  createGithubLabelListener,
  updateGithubLabelListener,
  deleteGithubLabelListener,
} from "./domains/integrations-github";

// Domain modules - Integrations Phone
export {
  sendPhoneMessage,
  downloadPhoneFile,
  initPhoneFileUpload,
  completePhoneFileUpload,
} from "./domains/integrations-phone";

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

// Domain modules - Zero Chat
export { searchZeroChat } from "./domains/zero-chat";

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
  createComputerUseReadCommand,
  createComputerUseWriteCommand,
  fetchComputerUseScreenshot,
  getComputerUseCommand,
} from "./domains/zero-computer-use";

// Domain modules - Zero Maps
export { callZeroMaps, type ZeroMapsResponse } from "./domains/zero-maps";

// Domain modules - Zero Banking
export {
  callZeroBanking,
  type ZeroBankingResponse,
} from "./domains/zero-banking";

// Domain modules - Web
export {
  downloadWebFile,
  uploadWebFile,
  generateWebVoice,
  generateWebImage,
  generateWebVideo,
} from "./domains/web";

// Domain modules - Zero Host
export { prepareHostedSite, completeHostedSite } from "./domains/zero-host";
