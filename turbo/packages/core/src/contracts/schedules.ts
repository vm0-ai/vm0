import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Schedule trigger type - cron (recurring), at (one-time), or loop (completion-based interval)
 */
const scheduleTriggerSchema = z
  .object({
    cron: z.string().optional(),
    at: z.string().optional(),
    loop: z.object({ interval: z.number().int().min(0) }).optional(),
    timezone: z.string().default("UTC"),
  })
  .refine(
    (data) => {
      const triggers = [data.cron, data.at, data.loop].filter(Boolean);
      return triggers.length === 1;
    },
    {
      message: "Exactly one of 'cron', 'at', or 'loop' must be specified",
    },
  );

/**
 * Schedule run configuration - what to execute
 */
const scheduleRunConfigSchema = z.object({
  agent: z.string().min(1, "Agent reference required"),
  prompt: z.string().min(1, "Prompt required"),
  vars: z.record(z.string(), z.string()).optional(),
  secrets: z.record(z.string(), z.string()).optional(),
  artifactName: z.string().optional(),
  artifactVersion: z.string().optional(),
  volumeVersions: z.record(z.string(), z.string()).optional(),
});

/**
 * Single schedule definition in YAML
 */
const scheduleDefinitionSchema = z.object({
  on: scheduleTriggerSchema,
  run: scheduleRunConfigSchema,
});

/**
 * Full schedule.yaml schema
 */
export const scheduleYamlSchema = z.object({
  version: z.literal("1.0"),
  schedules: z.record(z.string(), scheduleDefinitionSchema),
});

/**
 * Deploy schedule request - sent from CLI to API
 * Note: vars and secrets are no longer accepted via API
 * They must be managed via platform tables (vm0 secret set, vm0 var set)
 */
const deployScheduleRequestSchema = z
  .object({
    name: z.string().min(1).max(64, "Schedule name max 64 chars"),
    cronExpression: z.string().optional(),
    atTime: z.string().optional(),
    intervalSeconds: z.number().int().min(0).optional(),
    timezone: z.string().default("UTC"),
    prompt: z.string().min(1, "Prompt required"),
    // vars and secrets removed - now managed via platform tables
    artifactName: z.string().optional(),
    artifactVersion: z.string().optional(),
    volumeVersions: z.record(z.string(), z.string()).optional(),
    // Resolved agent compose ID (CLI resolves org/name:version → composeId)
    composeId: z.string().uuid("Invalid compose ID"),
    // Enable schedule immediately upon creation
    enabled: z.boolean().optional(),
    // Per-schedule notification control (AND'd with user global preferences)
    notifyEmail: z.boolean().optional(),
    notifySlack: z.boolean().optional(),
  })
  .refine(
    (data) => {
      const triggers = [
        data.cronExpression,
        data.atTime,
        data.intervalSeconds,
      ].filter((v) => v !== undefined);
      return triggers.length === 1;
    },
    {
      message:
        "Exactly one of 'cronExpression', 'atTime', or 'intervalSeconds' must be specified",
    },
  );

/**
 * Schedule response - returned from API
 */
const scheduleResponseSchema = z.object({
  id: z.string().uuid(),
  composeId: z.string().uuid(),
  composeName: z.string(),
  orgSlug: z.string(),
  userId: z.string(),
  name: z.string(),
  triggerType: z.enum(["cron", "once", "loop"]),
  cronExpression: z.string().nullable(),
  atTime: z.string().nullable(),
  intervalSeconds: z.number().nullable(),
  timezone: z.string(),
  prompt: z.string(),
  vars: z.record(z.string(), z.string()).nullable(),
  // Secret names only (values are never returned)
  secretNames: z.array(z.string()).nullable(),
  artifactName: z.string().nullable(),
  artifactVersion: z.string().nullable(),
  volumeVersions: z.record(z.string(), z.string()).nullable(),
  enabled: z.boolean(),
  notifyEmail: z.boolean(),
  notifySlack: z.boolean(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  retryStartedAt: z.string().nullable(),
  consecutiveFailures: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Run summary for schedule runs list
 */
const runSummarySchema = z.object({
  id: z.string().uuid(),
  status: z.enum([
    "queued",
    "pending",
    "running",
    "completed",
    "failed",
    "timeout",
  ]),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  error: z.string().nullable(),
});

/**
 * Schedule runs list response
 */
const scheduleRunsResponseSchema = z.object({
  runs: z.array(runSummarySchema),
});

/**
 * List of schedules response
 */
const scheduleListResponseSchema = z.object({
  schedules: z.array(scheduleResponseSchema),
});

/**
 * Deploy result response
 */
const deployScheduleResponseSchema = z.object({
  schedule: scheduleResponseSchema,
  created: z.boolean(), // true if created, false if updated
});

/**
 * Schedules main route contract (/api/agent/schedules)
 * Handles POST deploy, GET list
 */
export const schedulesMainContract = c.router({
  /**
   * POST /api/agent/schedules
   * Deploy (create or update) a schedule
   */
  deploy: {
    method: "POST",
    path: "/api/agent/schedules",
    headers: authHeadersSchema,
    body: deployScheduleRequestSchema,
    responses: {
      200: deployScheduleResponseSchema, // Updated
      201: deployScheduleResponseSchema, // Created
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Deploy schedule (create or update)",
  },

  /**
   * GET /api/agent/schedules
   * List all schedules for the user
   */
  list: {
    method: "GET",
    path: "/api/agent/schedules",
    headers: authHeadersSchema,
    responses: {
      200: scheduleListResponseSchema,
      401: apiErrorSchema,
    },
    summary: "List all schedules",
  },
});

/**
 * Schedules by name route contract (/api/agent/schedules/[name])
 * Uses name for user-friendly URLs (e.g., vm0 schedule delete daily-report)
 */
export const schedulesByNameContract = c.router({
  /**
   * GET /api/agent/schedules/:name
   * Get schedule by name
   */
  getByName: {
    method: "GET",
    path: "/api/agent/schedules/:name",
    headers: authHeadersSchema,
    pathParams: z.object({
      name: z.string().min(1, "Schedule name required"),
    }),
    query: z.object({
      composeId: z.string().uuid("Compose ID required"),
    }),
    responses: {
      200: scheduleResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get schedule by name",
  },

  /**
   * DELETE /api/agent/schedules/:name
   * Delete schedule by name
   */
  delete: {
    method: "DELETE",
    path: "/api/agent/schedules/:name",
    headers: authHeadersSchema,
    pathParams: z.object({
      name: z.string().min(1, "Schedule name required"),
    }),
    query: z.object({
      composeId: z.string().uuid("Compose ID required"),
    }),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete schedule",
  },
});

/**
 * Schedule enable/disable route contract
 */
export const schedulesEnableContract = c.router({
  /**
   * POST /api/agent/schedules/:name/enable
   * Enable a disabled schedule
   */
  enable: {
    method: "POST",
    path: "/api/agent/schedules/:name/enable",
    headers: authHeadersSchema,
    pathParams: z.object({
      name: z.string().min(1, "Schedule name required"),
    }),
    body: z.object({
      composeId: z.string().uuid("Compose ID required"),
    }),
    responses: {
      200: scheduleResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Enable schedule",
  },

  /**
   * POST /api/agent/schedules/:name/disable
   * Disable an enabled schedule
   */
  disable: {
    method: "POST",
    path: "/api/agent/schedules/:name/disable",
    headers: authHeadersSchema,
    pathParams: z.object({
      name: z.string().min(1, "Schedule name required"),
    }),
    body: z.object({
      composeId: z.string().uuid("Compose ID required"),
    }),
    responses: {
      200: scheduleResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disable schedule",
  },
});

/**
 * Schedule runs route contract (/api/agent/schedules/[name]/runs)
 * Lists recent runs for a schedule
 */
export const scheduleRunsContract = c.router({
  /**
   * GET /api/agent/schedules/:name/runs
   * List recent runs for a schedule
   */
  listRuns: {
    method: "GET",
    path: "/api/agent/schedules/:name/runs",
    headers: authHeadersSchema,
    pathParams: z.object({
      name: z.string().min(1, "Schedule name required"),
    }),
    query: z.object({
      composeId: z.string().uuid("Compose ID required"),
      limit: z.coerce.number().min(0).max(100).default(5),
    }),
    responses: {
      200: scheduleRunsResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List recent runs for a schedule",
  },
});

// Type exports
export type SchedulesMainContract = typeof schedulesMainContract;
export type SchedulesByNameContract = typeof schedulesByNameContract;
export type SchedulesEnableContract = typeof schedulesEnableContract;
export type ScheduleRunsContract = typeof scheduleRunsContract;

// Schema exports for reuse
export {
  scheduleTriggerSchema,
  scheduleRunConfigSchema,
  scheduleDefinitionSchema,
  deployScheduleRequestSchema,
  scheduleResponseSchema,
  scheduleListResponseSchema,
  deployScheduleResponseSchema,
  runSummarySchema,
  scheduleRunsResponseSchema,
};

// Export inferred types for consumers
export type ScheduleTrigger = z.infer<typeof scheduleTriggerSchema>;
export type ScheduleRunConfig = z.infer<typeof scheduleRunConfigSchema>;
export type ScheduleDefinition = z.infer<typeof scheduleDefinitionSchema>;
export type DeployScheduleRequest = z.infer<typeof deployScheduleRequestSchema>;
export type ScheduleResponse = z.infer<typeof scheduleResponseSchema>;
export type ScheduleListResponse = z.infer<typeof scheduleListResponseSchema>;
export type DeployScheduleResponse = z.infer<
  typeof deployScheduleResponseSchema
>;
export type RunSummary = z.infer<typeof runSummarySchema>;
export type ScheduleRunsResponse = z.infer<typeof scheduleRunsResponseSchema>;
