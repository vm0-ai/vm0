import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Schedule response schema — shared by all schedule endpoints
 */
export const scheduleResponseSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  displayName: z.string().nullable(),
  userId: z.string(),
  name: z.string(),
  triggerType: z.enum(["cron", "once", "loop"]),
  cronExpression: z.string().nullable(),
  atTime: z.string().nullable(),
  intervalSeconds: z.number().nullable(),
  timezone: z.string(),
  prompt: z.string(),
  description: z.string().nullable(),
  appendSystemPrompt: z.string().nullable(),
  vars: z.record(z.string(), z.string()).nullable(),
  secretNames: z.array(z.string()).nullable(),
  volumeVersions: z.record(z.string(), z.string()).nullable(),
  enabled: z.boolean(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  retryStartedAt: z.string().nullable(),
  consecutiveFailures: z.number(),
  // Linked chat thread (chat mode). Read-only: set at creation, immutable after.
  // Null = legacy schedule (no chat thread).
  chatThreadId: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const scheduleListResponseSchema = z.object({
  schedules: z.array(scheduleResponseSchema),
});

export const deployScheduleResponseSchema = z.object({
  schedule: scheduleResponseSchema,
  created: z.boolean(),
});

/**
 * Zero deploy schedule request — requires agentId (compose UUID).
 */
const zeroDeployScheduleRequestSchema = z
  .object({
    name: z.string().min(1).max(64, "Schedule name max 64 chars"),
    cronExpression: z.string().optional(),
    atTime: z.string().optional(),
    intervalSeconds: z.number().int().min(0).optional(),
    timezone: z.string().default("UTC"),
    prompt: z.string().min(1, "Prompt required"),
    description: z.string().optional(),
    appendSystemPrompt: z.string().optional(),
    volumeVersions: z.record(z.string(), z.string()).optional(),
    agentId: z.string().uuid("Invalid agent ID"),
    enabled: z.boolean().optional(),
    // Chat-mode linkage, accepted only on creation of a new schedule. When
    // provided, links the schedule to an existing chat thread; when omitted and
    // chat-mode schedules are enabled, the server creates a web chat thread and
    // links it. Rejected on update of an existing schedule (link is immutable).
    chatThreadId: z.string().uuid("Invalid chat thread ID").optional(),
  })
  .refine(
    (data) => {
      const triggers = [
        data.cronExpression,
        data.atTime,
        data.intervalSeconds,
      ].filter((v) => {
        return v !== undefined;
      });
      return triggers.length === 1;
    },
    {
      message:
        "Exactly one of 'cronExpression', 'atTime', or 'intervalSeconds' must be specified",
    },
  );

/**
 * Zero schedules main contract (GET/POST /api/zero/schedules)
 */
export const zeroSchedulesMainContract = c.router({
  deploy: {
    method: "POST",
    path: "/api/zero/schedules",
    headers: authHeadersSchema,
    body: zeroDeployScheduleRequestSchema,
    responses: {
      200: deployScheduleResponseSchema,
      201: deployScheduleResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Deploy schedule (zero proxy)",
  },
  list: {
    method: "GET",
    path: "/api/zero/schedules",
    headers: authHeadersSchema,
    responses: {
      200: scheduleListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List all schedules (zero proxy)",
  },
});

/**
 * Zero schedules by name contract (DELETE /api/zero/schedules/:name)
 */
export const zeroSchedulesByNameContract = c.router({
  delete: {
    method: "DELETE",
    path: "/api/zero/schedules/:name",
    headers: authHeadersSchema,
    pathParams: z.object({
      name: z.string().min(1, "Schedule name required"),
    }),
    query: z.object({
      agentId: z.string().uuid("Invalid agent ID"),
    }),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete schedule (zero proxy)",
  },
});

/**
 * Zero schedules enable/disable contract
 */
export const zeroSchedulesEnableContract = c.router({
  enable: {
    method: "POST",
    path: "/api/zero/schedules/:name/enable",
    headers: authHeadersSchema,
    pathParams: z.object({
      name: z.string().min(1, "Schedule name required"),
    }),
    body: z.object({
      agentId: z.string().uuid("Invalid agent ID"),
    }),
    responses: {
      200: scheduleResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Enable schedule (zero proxy)",
  },
  disable: {
    method: "POST",
    path: "/api/zero/schedules/:name/disable",
    headers: authHeadersSchema,
    pathParams: z.object({
      name: z.string().min(1, "Schedule name required"),
    }),
    body: z.object({
      agentId: z.string().uuid("Invalid agent ID"),
    }),
    responses: {
      200: scheduleResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disable schedule (zero proxy)",
  },
});

/**
 * Zero schedule run-now contract (POST /api/zero/schedules/run)
 */
export const zeroScheduleRunContract = c.router({
  run: {
    method: "POST",
    path: "/api/zero/schedules/run",
    headers: authHeadersSchema,
    body: z.object({
      scheduleId: z.string().uuid("Invalid schedule ID"),
    }),
    responses: {
      201: z.object({ runId: z.string() }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      429: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Execute a schedule immediately (run now)",
  },
});

/**
 * Zero schedule migrate-to-chat contract
 * (POST /api/zero/schedules/:name/migrate-to-chat)
 *
 * One-way migration for legacy schedules (chatThreadId === null): creates a new
 * chat thread and links it to the schedule. Only the null -> set transition is
 * allowed; an already-linked schedule is returned unchanged (idempotent). The
 * link can never be re-pointed, preserving the create-only immutability of
 * chatThreadId.
 */
export const zeroScheduleMigrateChatContract = c.router({
  migrateToChat: {
    method: "POST",
    path: "/api/zero/schedules/:name/migrate-to-chat",
    headers: authHeadersSchema,
    pathParams: z.object({
      name: z.string().min(1, "Schedule name required"),
    }),
    body: z.object({
      agentId: z.string().uuid("Invalid agent ID"),
    }),
    responses: {
      200: scheduleResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Migrate a legacy schedule to chat mode (create + link a thread)",
  },
});

// Contract type exports
export type ZeroSchedulesMainContract = typeof zeroSchedulesMainContract;
export type ZeroSchedulesByNameContract = typeof zeroSchedulesByNameContract;
export type ZeroSchedulesEnableContract = typeof zeroSchedulesEnableContract;
export type ZeroScheduleRunContract = typeof zeroScheduleRunContract;
export type ZeroScheduleMigrateChatContract =
  typeof zeroScheduleMigrateChatContract;

// Inferred types from response schemas
export type ScheduleResponse = z.infer<typeof scheduleResponseSchema>;
export type ScheduleListResponse = z.infer<typeof scheduleListResponseSchema>;
export type DeployScheduleResponse = z.infer<
  typeof deployScheduleResponseSchema
>;
