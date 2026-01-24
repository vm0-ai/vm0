import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Schedule trigger type - either cron (recurring) or at (one-time)
 */
const scheduleTriggerSchema = z
  .object({
    cron: z.string().optional(),
    at: z.string().optional(),
    timezone: z.string().default("UTC"),
  })
  .refine((data) => (data.cron && !data.at) || (!data.cron && data.at), {
    message: "Exactly one of 'cron' or 'at' must be specified",
  });

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
 */
const deployScheduleRequestSchema = z
  .object({
    name: z.string().min(1).max(64, "Schedule name max 64 chars"),
    cronExpression: z.string().optional(),
    atTime: z.string().optional(),
    timezone: z.string().default("UTC"),
    prompt: z.string().min(1, "Prompt required"),
    vars: z.record(z.string(), z.string()).optional(),
    secrets: z.record(z.string(), z.string()).optional(),
    artifactName: z.string().optional(),
    artifactVersion: z.string().optional(),
    volumeVersions: z.record(z.string(), z.string()).optional(),
    // Resolved agent compose ID (CLI resolves scope/name:version → composeId)
    composeId: z.string().uuid("Invalid compose ID"),
  })
  .refine(
    (data) =>
      (data.cronExpression && !data.atTime) ||
      (!data.cronExpression && data.atTime),
    {
      message: "Exactly one of 'cronExpression' or 'atTime' must be specified",
    },
  );

/**
 * Schedule response - returned from API
 */
const scheduleResponseSchema = z.object({
  id: z.string().uuid(),
  composeId: z.string().uuid(),
  composeName: z.string(),
  scopeSlug: z.string(),
  name: z.string(),
  cronExpression: z.string().nullable(),
  atTime: z.string().nullable(),
  timezone: z.string(),
  prompt: z.string(),
  vars: z.record(z.string(), z.string()).nullable(),
  // Secret names only (values are never returned)
  secretNames: z.array(z.string()).nullable(),
  artifactName: z.string().nullable(),
  artifactVersion: z.string().nullable(),
  volumeVersions: z.record(z.string(), z.string()).nullable(),
  enabled: z.boolean(),
  nextRunAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Run summary for schedule runs list
 */
const runSummarySchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["pending", "running", "completed", "failed", "timeout"]),
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
      409: apiErrorSchema, // Schedule limit reached
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
      204: z.undefined(),
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
