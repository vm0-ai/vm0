// Core types (only export what's actually used)
export type { RunResult } from "./core/types";

// Custom error class
export { ApiRequestError } from "./core/client-factory";

// HTTP utilities (only export what's actually used)

// Domain modules - Registry Resources
export { getRegistryResourceDownload } from "./domains/registry-resources";

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
  getZeroAgentCustomConnectors,
  listZeroUserPermissionGrants,
} from "./domains/zero-agents";

// Domain modules - Zero Workflows
export {
  type ZeroWorkflowAutomationCreateRequest,
  type ZeroWorkflowAutomationUpdateRequest,
  type ZeroWorkflowAutomationSummary,
  listWorkflows,
  createWorkflow,
  getWorkflow,
  updateWorkflow,
  deleteWorkflow,
  copyWorkflow,
  listWorkflowAutomations,
  createWorkflowAutomation,
  getWorkflowAutomation,
  updateWorkflowAutomation,
  deleteWorkflowAutomation,
  enableWorkflowAutomation,
  disableWorkflowAutomation,
} from "./domains/zero-workflows";

// Domain modules - Zero Goals
export {
  createGoal,
  editGoal,
  getGoal,
  completeGoal,
  blockGoal,
  pauseGoal,
  resumeGoal,
  clearGoal,
} from "./domains/zero-goals";

// Domain modules - Zero Connectors
export {
  listZeroConnectors,
  listZeroConnectorCatalog,
  listZeroConnectorCatalogStatus,
  getZeroConnectorCatalogPermissions,
  connectZeroConnectorManualGrant,
  listZeroCustomConnectors,
  getZeroCustomConnector,
} from "./domains/zero-connectors";

// Domain modules - Zero Mail
export { linkZeroMailDraft } from "./domains/zero-mail";

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

// Domain modules - Integrations Teams
export {
  sendTeamsMessage,
  initTeamsFileUpload,
  completeTeamsFileUpload,
  downloadTeamsFile,
} from "./domains/integrations-teams";

// Domain modules - Integrations GitHub
export {
  downloadGithubFile,
  initGithubFileUpload,
  completeGithubFileUpload,
} from "./domains/integrations-github";

// Domain modules - Integrations Phone
export {
  sendPhoneMessage,
  downloadPhoneFile,
  initPhoneFileUpload,
  completePhoneFileUpload,
} from "./domains/integrations-phone";

// Domain modules - Zero Runs
export { getZeroRunAgentEvents } from "./domains/zero-runs";
export type {
  RunEvent,
  LogsSearchResponse,
} from "@vm0/api-contracts/contracts/runs";

// Domain modules - Zero Logs
export { listZeroLogs, searchZeroLogs } from "./domains/zero-logs";

// Domain modules - Zero Chat
export {
  getZeroChatThread,
  renameZeroChatThread,
  searchZeroChat,
  updateZeroChatThreadModelSelection,
} from "./domains/zero-chat";

// Domain modules - Zero Developer Support
export {
  requestDeveloperSupportConsent,
  submitDeveloperSupport,
} from "./domains/zero-developer-support";

// Domain modules - Zero Computer Use
export {
  createComputerUseAuthorizationRequest,
  createComputerUsePluginCommand,
  listComputerUseHosts,
  createComputerUseReadCommand,
  createComputerUseWriteCommand,
  fetchComputerUsePluginContent,
  fetchComputerUseScreenshot,
  getComputerUseCommand,
} from "./domains/zero-computer-use";

// Domain modules - Zero Maps
export { callZeroMaps, type ZeroMapsResponse } from "./domains/zero-maps";

// Domain modules - Zero Weather
export {
  callZeroWeather,
  type ZeroWeatherResponse,
} from "./domains/zero-weather";

// Domain modules - Zero Scrape
export { callZeroScrape, type ZeroScrapeResponse } from "./domains/zero-scrape";
export {
  callZeroWebSearch,
  type ZeroWebSearchResponse,
} from "./domains/zero-web-search";

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
export {
  prepareHostedSite,
  completeHostedSite,
  getHostedSiteFiles,
  getHostedSiteDeployments,
} from "./domains/zero-host";
