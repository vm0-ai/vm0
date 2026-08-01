import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { connectorCatalogDiagnosticsSchema } from "./connector-catalog-diagnostics";
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

const cronCompactUsageEventsResponseSchema = z.object({
  success: z.literal(true),
  cutoff: z.string(),
  rawSeedLimit: z.number().int().positive(),
  seededRawRows: z.number().int().nonnegative(),
  selectedGrains: z.number().int().nonnegative(),
  probedRawRows: z.number().int().nonnegative(),
  billingErrorHeldRows: z.number().int().nonnegative(),
  rawRowsDeleted: z.number().int().nonnegative(),
  hourlyRowsDeleted: z.number().int().nonnegative(),
  hourlyRowsInserted: z.number().int().nonnegative(),
  quantity: z.string().regex(/^-?\d+$/),
  creditsCharged: z.string().regex(/^-?\d+$/),
  allowanceUnits: z.string().regex(/^-?\d+$/),
  affectedShortWindows: z.number().int().nonnegative(),
  affectedWeeklyWindows: z.number().int().nonnegative(),
  reconciled: z.literal(true),
  hasMore: z.boolean(),
  lockWaitMs: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});

const cronMonitorChatEventQueueResponseSchema = z.object({
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

const cronBrowserReconcileResponseSchema = z.object({
  checked: z.number().int().nonnegative(),
  stopped: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  healthy: z.number().int().nonnegative(),
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

const connectorCatalogSyncResponseSchema =
  connectorCatalogDiagnosticsSchema.extend({
    outcome: z.enum(["accepted", "unchanged", "rejected"]),
  });

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

const cronAggregateModelStatsResponseSchema = z.object({
  success: z.literal(true),
  cutoff: z.iso.datetime(),
  processedHours: z.number().int().nonnegative(),
  processedObservations: z.number().int().nonnegative(),
  updatedStats: z.number().int().nonnegative(),
  deletedObservations: z.number().int().nonnegative(),
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

export const cronCompactUsageEventsContract = c.router({
  compact: {
    method: "GET",
    path: "/api/cron/compact-usage-events",
    headers: authHeadersSchema,
    responses: {
      200: cronCompactUsageEventsResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Compact stable usage events into hourly rollups",
  },
});

export const cronMonitorChatEventQueueContract = c.router({
  monitor: {
    method: "GET",
    path: "/api/cron/monitor-chat-event-queue",
    headers: authHeadersSchema,
    responses: {
      200: cronMonitorChatEventQueueResponseSchema,
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

export const cronBrowserReconcileContract = c.router({
  reconcile: {
    method: "GET",
    path: "/api/cron/reconcile-browsers",
    headers: authHeadersSchema,
    responses: {
      200: cronBrowserReconcileResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Reconcile managed browser idle leases and provider state",
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
    query: z.object({}).strict(),
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
export type CronMonitorChatEventQueueContract =
  typeof cronMonitorChatEventQueueContract;
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
export type CronBrowserReconcileContract = typeof cronBrowserReconcileContract;
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
  cronBrowserReconcileResponseSchema,
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
