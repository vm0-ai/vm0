import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
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

const cronReconcileBillingEntitlementsResponseSchema = z.object({
  success: z.literal(true),
  downgraded: z.number(),
});

const cronTelegramCleanupResponseSchema = z.object({
  deleted: z.number(),
});

const cronVoiceChatCleanupResponseSchema = z.object({
  success: z.literal(true),
  reasonerReset: z.number(),
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

const cronExecuteSchedulesResponseSchema = z.object({
  success: z.literal(true),
  executed: z.number(),
  skipped: z.number(),
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

export const cronVoiceChatCleanupContract = c.router({
  cleanup: {
    method: "GET",
    path: "/api/cron/voice-chat-cleanup",
    headers: authHeadersSchema,
    responses: {
      200: cronVoiceChatCleanupResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Reset stuck voice-chat reasoners",
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

export const cronExecuteSchedulesContract = c.router({
  execute: {
    method: "GET",
    path: "/api/cron/execute-schedules",
    headers: authHeadersSchema,
    responses: {
      200: cronExecuteSchedulesResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Execute due schedules",
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

export type CronAggregateUsageContract = typeof cronAggregateUsageContract;
export type CronProcessUsageEventsContract =
  typeof cronProcessUsageEventsContract;
export type CronReconcileBillingEntitlementsContract =
  typeof cronReconcileBillingEntitlementsContract;
export type CronAggregateInsightsContract =
  typeof cronAggregateInsightsContract;
export type CronTelegramCleanupContract = typeof cronTelegramCleanupContract;
export type CronVoiceChatCleanupContract = typeof cronVoiceChatCleanupContract;
export type CronDrainEmailOutboxContract = typeof cronDrainEmailOutboxContract;
export type CronSyncSkillsContract = typeof cronSyncSkillsContract;
export type CronExecuteSchedulesContract = typeof cronExecuteSchedulesContract;

// Export schemas for reuse
export {
  cleanupResultSchema,
  cleanupResponseSchema,
  cronAggregateUsageResponseSchema,
  cronProcessUsageEventsResponseSchema,
  cronReconcileBillingEntitlementsResponseSchema,
  cronTelegramCleanupResponseSchema,
  cronVoiceChatCleanupResponseSchema,
  cronDrainEmailOutboxResponseSchema,
  cronSyncSkillsResponseSchema,
  cronExecuteSchedulesResponseSchema,
  cronAggregateInsightsResponseSchema,
};
