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
export { secretsContract, type SecretsContract } from "./secrets";
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
  type RunsMainContract,
  type RunsByIdContract,
  type RunEventsContract,
  type RunTelemetryContract,
  type RunSystemLogContract,
  type RunMetricsContract,
  type RunAgentEventsContract,
} from "./runs";
export {
  sessionsMainContract,
  sessionsByIdContract,
  agentSessionSchema,
  conversationSchema,
  agentSessionWithConversationSchema,
  type SessionsMainContract,
  type SessionsByIdContract,
} from "./sessions";
export {
  storagesContract,
  storageTypeSchema,
  uploadStorageResponseSchema,
  type StoragesContract,
} from "./storages";
export {
  webhookEventsContract,
  webhookCompleteContract,
  webhookCheckpointsContract,
  webhookHeartbeatContract,
  webhookStoragesContract,
  webhookStoragesIncrementalContract,
  webhookTelemetryContract,
  type WebhookEventsContract,
  type WebhookCompleteContract,
  type WebhookCheckpointsContract,
  type WebhookHeartbeatContract,
  type WebhookStoragesContract,
  type WebhookStoragesIncrementalContract,
  type WebhookTelemetryContract,
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
