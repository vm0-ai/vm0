/**
 * ts-rest API Contracts
 *
 * This module provides type-safe API contracts using ts-rest.
 *
 * IMPORTANT: We use @ts-rest/core@3.53.0-rc.1 (RC version) because:
 * - The stable version (3.52.x) requires Zod v3
 * - This project uses Zod v4 which has breaking type changes
 * - The RC version adds Zod v4 compatibility
 *
 * TODO: Upgrade to stable @ts-rest/core@3.53.0 when released.
 * Track: https://github.com/ts-rest/ts-rest/releases
 */
export { initContract } from "./base";
export {
  apiErrorSchema,
  ApiError,
  createErrorResponse,
  type ApiErrorKey,
  type ApiErrorResponse,
} from "./errors";
export {
  composesMainContract,
  composesByIdContract,
  composesVersionsContract,
  type ComposesMainContract,
  type ComposesByIdContract,
  type ComposesVersionsContract,
  agentNameSchema,
  volumeConfigSchema,
  agentDefinitionSchema,
  agentComposeContentSchema,
  composeResponseSchema,
} from "./composes";
export {
  runsMainContract,
  runsByIdContract,
  runEventsContract,
  runTelemetryContract,
  runSystemLogContract,
  runMetricsContract,
  runAgentEventsContract,
  runNetworkLogsContract,
  runStatusSchema,
  unifiedRunRequestSchema,
  createRunResponseSchema,
  getRunResponseSchema,
  runEventSchema,
  eventsResponseSchema,
  telemetryMetricSchema,
  telemetryResponseSchema,
  systemLogResponseSchema,
  metricsResponseSchema,
  agentEventsResponseSchema,
  networkLogEntrySchema,
  networkLogsResponseSchema,
  type RunsMainContract,
  type RunsByIdContract,
  type RunEventsContract,
  type RunTelemetryContract,
  type RunSystemLogContract,
  type RunMetricsContract,
  type RunAgentEventsContract,
  type RunNetworkLogsContract,
} from "./runs";
export {
  storagesContract,
  storageTypeSchema,
  uploadStorageResponseSchema,
  // Direct upload schemas (shared with webhooks)
  fileEntryWithHashSchema,
  storageChangesSchema,
  presignedUploadSchema,
  // Direct upload contracts (CLI endpoints)
  storagesPrepareContract,
  storagesCommitContract,
  storagesDownloadContract,
  storagesListContract,
  type StoragesContract,
  type StoragesPrepareContract,
  type StoragesCommitContract,
  type StoragesDownloadContract,
  type StoragesListContract,
} from "./storages";
export {
  webhookEventsContract,
  webhookCompleteContract,
  webhookCheckpointsContract,
  webhookHeartbeatContract,
  webhookStoragesContract,
  webhookStoragesIncrementalContract,
  webhookTelemetryContract,
  // Direct upload contracts (Webhook endpoints for sandbox)
  webhookStoragesPrepareContract,
  webhookStoragesCommitContract,
  type WebhookEventsContract,
  type WebhookCompleteContract,
  type WebhookCheckpointsContract,
  type WebhookHeartbeatContract,
  type WebhookStoragesContract,
  type WebhookStoragesIncrementalContract,
  type WebhookTelemetryContract,
  type WebhookStoragesPrepareContract,
  type WebhookStoragesCommitContract,
} from "./webhooks";
export {
  cliAuthDeviceContract,
  cliAuthTokenContract,
  type CliAuthDeviceContract,
  type CliAuthTokenContract,
} from "./cli-auth";
export { authContract, type AuthContract } from "./auth";
export {
  imagesMainContract,
  imagesByIdContract,
  imageBuildsContract,
  buildStatusSchema,
  imageInfoSchema,
  createImageRequestSchema,
  createImageResponseSchema,
  buildStatusResponseSchema,
  type ImagesMainContract,
  type ImagesByIdContract,
  type ImageBuildsContract,
} from "./images";
export {
  cronCleanupSandboxesContract,
  cleanupResultSchema,
  cleanupResponseSchema,
  type CronCleanupSandboxesContract,
} from "./cron";
export {
  proxyErrorSchema,
  ProxyErrorCode,
  type ProxyError,
  type ProxyErrorCode as ProxyErrorCodeType,
} from "./proxy";
export {
  scopeContract,
  scopeTypeSchema,
  scopeSlugSchema,
  scopeResponseSchema,
  createScopeRequestSchema,
  updateScopeRequestSchema,
  type ScopeContract,
  type ScopeTypeContract,
  type ScopeResponse,
  type CreateScopeRequest,
  type UpdateScopeRequest,
} from "./scopes";
export {
  sessionsByIdContract,
  checkpointsByIdContract,
  sessionResponseSchema,
  checkpointResponseSchema,
  agentComposeSnapshotSchema,
  artifactSnapshotSchema,
  volumeVersionsSnapshotSchema,
  type SessionsByIdContract,
  type CheckpointsByIdContract,
} from "./sessions";
export {
  runnersPollContract,
  runnersJobClaimContract,
  runnerGroupSchema,
  jobSchema,
  executionContextSchema,
  storedExecutionContextSchema,
  storageEntrySchema,
  artifactEntrySchema,
  storageManifestSchema,
  resumeSessionSchema,
  type RunnersPollContract,
  type RunnersJobClaimContract,
  type Job,
  type ExecutionContext,
  type StoredExecutionContext,
  type StorageEntry,
  type ArtifactEntry,
  type StorageManifest,
  type ResumeSession,
} from "./runners";
