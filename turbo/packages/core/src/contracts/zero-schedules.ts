import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  scheduleListResponseSchema,
  deployScheduleResponseSchema,
  scheduleResponseSchema,
} from "./schedules";

const c = initContract();

/**
 * Zero deploy schedule request — uses zeroAgentId instead of composeId
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
    artifactName: z.string().optional(),
    artifactVersion: z.string().optional(),
    volumeVersions: z.record(z.string(), z.string()).optional(),
    // Resolved zero agent ID (platform resolves org/name → zeroAgentId)
    zeroAgentId: z.string().uuid("Invalid agent ID"),
    enabled: z.boolean().optional(),
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
      zeroAgentId: z.string().uuid("Agent ID required"),
    }),
    responses: {
      204: c.noBody(),
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
      zeroAgentId: z.string().uuid("Agent ID required"),
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
      zeroAgentId: z.string().uuid("Agent ID required"),
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

// Type exports
export type ZeroSchedulesMainContract = typeof zeroSchedulesMainContract;
export type ZeroSchedulesByNameContract = typeof zeroSchedulesByNameContract;
export type ZeroSchedulesEnableContract = typeof zeroSchedulesEnableContract;
