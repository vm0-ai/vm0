import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import {
  connectorAuthMethodIdSchema,
  connectorRefSchema,
} from "./connector-identity";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Cleanup result schema
 */
const cleanupResultSchema = z.object({
  runId: z.string(),
  sandboxId: z.string().nullable(),
  status: z.enum(["cleaned", "error"]),
  error: z.string().optional(),
  reason: z.string().optional(),
});

/**
 * Cleanup response schema
 */
const cleanupResponseSchema = z.object({
  cleaned: z.number(),
  errors: z.number(),
  results: z.array(cleanupResultSchema),
  exportJobsCleaned: z.number(),
  exportJobsStuck: z.number(),
});

/**
 * Cron cleanup sandboxes contract for /api/cron/cleanup-sandboxes
 */
export const cronCleanupSandboxesContract = c.router({
  /**
   * GET /api/cron/cleanup-sandboxes
   * Cron job to cleanup sandboxes that have stopped sending heartbeats
   */
  cleanup: {
    method: "GET",
    path: "/api/cron/cleanup-sandboxes",
    headers: authHeadersSchema,
    responses: {
      200: cleanupResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Cleanup expired sandboxes",
  },
});

export type CronCleanupSandboxesContract = typeof cronCleanupSandboxesContract;

const cronAggregateUsageResponseSchema = z.object({
  date: z.string(),
  aggregated: z.number(),
});

const cronProcessUsageEventsResponseSchema = z.object({
  success: z.literal(true),
  processed: z.number(),
});

const cronCompactChatThreadSnapshotsResponseSchema = z.object({
  success: z.literal(true),
  scopes: z.number(),
  eventsApplied: z.number(),
  removedDeletedAgentThreads: z.number(),
  eventsPruned: z.number(),
});

const cronMonitorChatMessageQueueResponseSchema = z.object({
  success: z.literal(true),
  orphanedMessages: z.number().int().nonnegative(),
});

const cronReconcileBillingEntitlementsResponseSchema = z.object({
  success: z.literal(true),
  downgraded: z.number(),
});

const cronTelegramCleanupResponseSchema = z.object({
  deleted: z.number(),
});

const cronConnectorOauthStateCleanupResponseSchema = z.object({
  deleted: z.number().int().nonnegative(),
});

const cronComputerUseScreenshotCleanupResponseSchema = z.object({
  cleaned: z.number(),
});

const cronDrainEmailOutboxResponseSchema = z.object({
  success: z.literal(true),
  drained: z.number(),
  cleaned: z.number(),
});

const cronSyncSkillsResponseSchema = z.object({
  success: z.literal(true),
  commitSha: z.string(),
  synced: z.number(),
  skipped: z.number(),
  failed: z.number(),
  removed: z.number(),
  total: z.number(),
});

export const connectorCatalogSyncFailureCodeSchema = z.enum([
  "source-unavailable",
  "object-too-large",
  "invalid-json",
  "invalid-pointer",
  "invalid-reference",
  "digest-mismatch",
  "unsupported-schema",
  "invalid-artifact",
  "public-leakage",
  "relationship-mismatch",
  "invalid-compression",
]);

export const connectorCatalogCompatibilityReasonSchema = z.enum([
  "missing-grant-provider",
  "missing-access-provider",
  "missing-revoke-provider",
  "provider-contract-mismatch",
  "missing-platform-configuration",
]);

export const connectorCatalogFilteredAuthMethodSchema = z.object({
  connectorRef: connectorRefSchema,
  authMethodId: connectorAuthMethodIdSchema,
  reasons: z.array(connectorCatalogCompatibilityReasonSchema).min(1),
});

export const connectorCatalogFilteredAuthMethodsSchema = z.array(
  connectorCatalogFilteredAuthMethodSchema,
);

const connectorCatalogFilteringStatusSchema = z.object({
  capabilityDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  evaluatedAt: z.string().datetime().nullable(),
  stale: z.boolean(),
  filteredAuthMethods: connectorCatalogFilteredAuthMethodsSchema,
});

const connectorCredentialStorageReadinessSchema = z.object({
  missingConnectorVersions: z.number().int().nonnegative(),
  unownedConnectorSecrets: z.number().int().nonnegative(),
  unownedConnectorVariables: z.number().int().nonnegative(),
  unresolvedBridgeCredentials: z.number().int().nonnegative(),
});

const connectorCatalogSyncStatusSchema = z.object({
  state: z.enum(["never-synced", "current", "stale"]),
  active: z
    .object({
      catalogVersion: z.string(),
      catalogDigest: z.string(),
      activatedAt: z.string().datetime(),
    })
    .nullable(),
  lastAttempt: z
    .object({
      at: z.string().datetime(),
      outcome: z.enum(["accepted", "unchanged", "rejected"]),
      failureCode: connectorCatalogSyncFailureCodeSchema.nullable(),
    })
    .nullable(),
  lastSuccessAt: z.string().datetime().nullable(),
  filtering: connectorCatalogFilteringStatusSchema,
  credentialStorage: connectorCredentialStorageReadinessSchema,
});

const connectorCatalogSyncResponseSchema =
  connectorCatalogSyncStatusSchema.extend({
    outcome: z.enum(["accepted", "unchanged", "rejected"]),
  });

export type ConnectorCatalogSyncFailureCode = z.infer<
  typeof connectorCatalogSyncFailureCodeSchema
>;
export type ConnectorCatalogCompatibilityReason = z.infer<
  typeof connectorCatalogCompatibilityReasonSchema
>;
export type ConnectorCatalogFilteredAuthMethod = z.infer<
  typeof connectorCatalogFilteredAuthMethodSchema
>;
export type ConnectorCatalogFilteringStatus = z.infer<
  typeof connectorCatalogFilteringStatusSchema
>;
export type ConnectorCatalogSyncStatus = z.infer<
  typeof connectorCatalogSyncStatusSchema
>;
export type ConnectorCatalogSyncResponse = z.infer<
  typeof connectorCatalogSyncResponseSchema
>;

const cronExecuteWorkflowAutomationsResponseSchema = z.object({
  success: z.literal(true),
  executed: z.number(),
  skipped: z.number(),
});

const cronExecuteMorningBriefsResponseSchema = z.object({
  success: z.literal(true),
  executed: z.number(),
  skipped: z.number(),
});

const cronRenewGmailWatchesResponseSchema = z.object({
  success: z.literal(true),
  renewed: z.number(),
  failed: z.number(),
});

const cronRenewGoogleCalendarWatchesResponseSchema = z.object({
  success: z.literal(true),
  renewed: z.number(),
  failed: z.number(),
});

const cronRenewGoogleWorkspaceEventSubscriptionsResponseSchema = z.object({
  success: z.literal(true),
  renewed: z.number(),
  repaired: z.number(),
  failed: z.number(),
});

const cronAggregateInsightsSkippedResponseSchema = z.object({
  users: z.number(),
  skipped: z.literal(true),
});

const cronAggregateInsightsAggregatedResponseSchema = z.object({
  users: z.number(),
  windows: z.number(),
  networkRows: z.number(),
});

const cronAggregateInsightsResponseSchema = z.union([
  cronAggregateInsightsSkippedResponseSchema,
  cronAggregateInsightsAggregatedResponseSchema,
]);

const storagePresignedUrlRefreshResultSchema = z.object({
  due: z.number(),
  refreshed: z.number(),
  pruned: z.number(),
});

const cronRefreshStoragePresignedUrlsResponseSchema = z.object({
  success: z.literal(true),
  system: storagePresignedUrlRefreshResultSchema,
  workflowSkill: storagePresignedUrlRefreshResultSchema,
});

export const CRON_AGGREGATE_MODEL_STATS_MAX_HOURS = 24 * 32;

const cronAggregateModelStatsResponseSchema = z.object({
  success: z.literal(true),
  windowStart: z.string(),
  windowEnd: z.string(),
  aggregated: z.number(),
});

export const cronAggregateUsageContract = c.router({
  aggregate: {
    method: "GET",
    path: "/api/cron/aggregate-usage",
    headers: authHeadersSchema,
    responses: {
      200: cronAggregateUsageResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Aggregate daily usage cache",
  },
});

export const cronProcessUsageEventsContract = c.router({
  process: {
    method: "GET",
    path: "/api/cron/process-usage-events",
    headers: authHeadersSchema,
    responses: {
      200: cronProcessUsageEventsResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Process pending usage events",
  },
});

export const cronCompactChatThreadSnapshotsContract = c.router({
  compact: {
    method: "GET",
    path: "/api/cron/compact-chat-thread-snapshots",
    headers: authHeadersSchema,
    responses: {
      200: cronCompactChatThreadSnapshotsResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Compact chat thread snapshots from lifecycle events",
  },
});

export const cronMonitorChatMessageQueueContract = c.router({
  monitor: {
    method: "GET",
    path: "/api/cron/monitor-chat-message-queue",
    headers: authHeadersSchema,
    responses: {
      200: cronMonitorChatMessageQueueResponseSchema,
      401: apiErrorSchema,
      500: z.object({ error: z.string() }),
    },
    summary: "Monitor for orphaned queued chat messages",
  },
});

export const cronReconcileBillingEntitlementsContract = c.router({
  reconcile: {
    method: "GET",
    path: "/api/cron/reconcile-billing-entitlements",
    headers: authHeadersSchema,
    responses: {
      200: cronReconcileBillingEntitlementsResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Reconcile billing entitlements",
  },
});

export const cronTelegramCleanupContract = c.router({
  cleanup: {
    method: "GET",
    path: "/api/cron/telegram-cleanup",
    headers: authHeadersSchema,
    responses: {
      200: cronTelegramCleanupResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Delete expired Telegram messages",
  },
});

export const cronConnectorOauthStateCleanupContract = c.router({
  cleanup: {
    method: "GET",
    path: "/api/cron/connector-oauth-state-cleanup",
    headers: authHeadersSchema,
    responses: {
      200: cronConnectorOauthStateCleanupResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Delete expired connector OAuth states",
  },
});

export const cronComputerUseScreenshotCleanupContract = c.router({
  cleanup: {
    method: "GET",
    path: "/api/cron/computer-use-screenshot-cleanup",
    headers: authHeadersSchema,
    responses: {
      200: cronComputerUseScreenshotCleanupResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Delete expired desktop computer-use screenshots",
  },
});

export const cronDrainEmailOutboxContract = c.router({
  drain: {
    method: "GET",
    path: "/api/cron/drain-email-outbox",
    headers: authHeadersSchema,
    responses: {
      200: cronDrainEmailOutboxResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Drain pending email outbox messages",
  },
});

export const cronRenewGmailWatchesContract = c.router({
  renew: {
    method: "GET",
    path: "/api/cron/renew-gmail-watches",
    headers: authHeadersSchema,
    responses: {
      200: cronRenewGmailWatchesResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Renew Gmail push notification watches",
  },
});

export const cronRenewGoogleCalendarWatchesContract = c.router({
  renew: {
    method: "GET",
    path: "/api/cron/renew-google-calendar-watches",
    headers: authHeadersSchema,
    responses: {
      200: cronRenewGoogleCalendarWatchesResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Renew Google Calendar push notification watches",
  },
});

export const cronRenewGoogleWorkspaceEventSubscriptionsContract = c.router({
  renew: {
    method: "GET",
    path: "/api/cron/renew-google-workspace-event-subscriptions",
    headers: authHeadersSchema,
    responses: {
      200: cronRenewGoogleWorkspaceEventSubscriptionsResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Renew Google Workspace Events subscriptions",
  },
});

export const cronSyncSkillsContract = c.router({
  sync: {
    method: "GET",
    path: "/api/cron/sync-skills",
    headers: authHeadersSchema,
    responses: {
      200: cronSyncSkillsResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Sync official skills from the skills repository",
  },
});

export const cronConnectorCatalogContract = c.router({
  sync: {
    method: "GET",
    path: "/api/cron/sync-connector-catalog",
    headers: authHeadersSchema,
    responses: {
      200: connectorCatalogSyncResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Sync the validated connector catalog snapshot",
  },
  status: {
    method: "GET",
    path: "/api/cron/connector-catalog-status",
    headers: authHeadersSchema,
    responses: {
      200: connectorCatalogSyncStatusSchema,
      401: apiErrorSchema,
    },
    summary: "Read connector catalog sync status",
  },
});

export const cronExecuteWorkflowAutomationsContract = c.router({
  execute: {
    method: "GET",
    path: "/api/cron/execute-workflow-automations",
    headers: authHeadersSchema,
    responses: {
      200: cronExecuteWorkflowAutomationsResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Execute due workflow automations",
  },
});

export const cronExecuteMorningBriefsContract = c.router({
  execute: {
    method: "GET",
    path: "/api/cron/execute-morning-briefs",
    headers: authHeadersSchema,
    responses: {
      200: cronExecuteMorningBriefsResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Execute due morning briefs",
  },
});

export const cronAggregateInsightsContract = c.router({
  aggregate: {
    method: "GET",
    path: "/api/cron/aggregate-insights",
    headers: authHeadersSchema,
    responses: {
      200: cronAggregateInsightsResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Aggregate daily usage insights",
  },
});

export const cronAggregateModelStatsContract = c.router({
  aggregate: {
    method: "GET",
    path: "/api/cron/aggregate-model-stats",
    headers: authHeadersSchema,
    query: z.object({
      hours: z.coerce
        .number()
        .int()
        .min(1)
        .max(CRON_AGGREGATE_MODEL_STATS_MAX_HOURS)
        .optional(),
    }),
    responses: {
      200: cronAggregateModelStatsResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Aggregate hourly model usage statistics",
  },
});

export const cronRefreshStoragePresignedUrlsContract = c.router({
  refresh: {
    method: "GET",
    path: "/api/cron/refresh-storage-presigned-urls",
    headers: authHeadersSchema,
    responses: {
      200: cronRefreshStoragePresignedUrlsResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Refresh cached storage presigned URLs",
  },
});

export type CronAggregateUsageContract = typeof cronAggregateUsageContract;
export type CronProcessUsageEventsContract =
  typeof cronProcessUsageEventsContract;
export type CronCompactChatThreadSnapshotsContract =
  typeof cronCompactChatThreadSnapshotsContract;
export type CronMonitorChatMessageQueueContract =
  typeof cronMonitorChatMessageQueueContract;
export type CronReconcileBillingEntitlementsContract =
  typeof cronReconcileBillingEntitlementsContract;
export type CronAggregateInsightsContract =
  typeof cronAggregateInsightsContract;
export type CronAggregateModelStatsContract =
  typeof cronAggregateModelStatsContract;
export type CronRefreshStoragePresignedUrlsContract =
  typeof cronRefreshStoragePresignedUrlsContract;
export type CronTelegramCleanupContract = typeof cronTelegramCleanupContract;
export type CronConnectorOauthStateCleanupContract =
  typeof cronConnectorOauthStateCleanupContract;
export type CronComputerUseScreenshotCleanupContract =
  typeof cronComputerUseScreenshotCleanupContract;
export type CronDrainEmailOutboxContract = typeof cronDrainEmailOutboxContract;
export type CronSyncSkillsContract = typeof cronSyncSkillsContract;
export type CronConnectorCatalogContract = typeof cronConnectorCatalogContract;
export type CronRenewGmailWatchesContract =
  typeof cronRenewGmailWatchesContract;
export type CronRenewGoogleCalendarWatchesContract =
  typeof cronRenewGoogleCalendarWatchesContract;
export type CronRenewGoogleWorkspaceEventSubscriptionsContract =
  typeof cronRenewGoogleWorkspaceEventSubscriptionsContract;

// Export schemas for reuse
export {
  cleanupResultSchema,
  cleanupResponseSchema,
  cronAggregateUsageResponseSchema,
  cronCompactChatThreadSnapshotsResponseSchema,
  cronProcessUsageEventsResponseSchema,
  cronReconcileBillingEntitlementsResponseSchema,
  cronTelegramCleanupResponseSchema,
  cronConnectorOauthStateCleanupResponseSchema,
  cronComputerUseScreenshotCleanupResponseSchema,
  cronDrainEmailOutboxResponseSchema,
  cronSyncSkillsResponseSchema,
  cronExecuteWorkflowAutomationsResponseSchema,
  cronRenewGmailWatchesResponseSchema,
  cronRenewGoogleCalendarWatchesResponseSchema,
  cronRenewGoogleWorkspaceEventSubscriptionsResponseSchema,
  cronAggregateInsightsResponseSchema,
  cronAggregateModelStatsResponseSchema,
  cronRefreshStoragePresignedUrlsResponseSchema,
};
