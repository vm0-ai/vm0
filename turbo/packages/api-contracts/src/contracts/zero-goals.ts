import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const zeroGoalStatusSchema = z.enum(["active", "blocked", "complete"]);
export type ZeroGoalStatus = z.infer<typeof zeroGoalStatusSchema>;

export const zeroGoalStopReasonSchema = z.enum(["paused", "blocked", "failed"]);
export type ZeroGoalStopReason = z.infer<typeof zeroGoalStopReasonSchema>;

export const zeroGoalPreferenceSchema = z.object({
  version: z.literal(1),
  objective: z.string().min(1),
  tokenBudget: z.number().int().positive().optional(),
  stopReason: zeroGoalStopReasonSchema.optional(),
});
export type ZeroGoalPreference = z.infer<typeof zeroGoalPreferenceSchema>;

export const zeroGoalCreateRequestSchema = z.object({
  objective: z.string().min(1).max(20_000),
  tokenBudget: z.number().int().positive().optional(),
});
export type ZeroGoalCreateRequest = z.infer<typeof zeroGoalCreateRequestSchema>;

export const zeroGoalEditRequestSchema = z.object({
  objective: z.string().min(1).max(20_000).optional(),
  tokenBudget: z.number().int().positive().optional(),
});
export type ZeroGoalEditRequest = z.infer<typeof zeroGoalEditRequestSchema>;

export const zeroGoalResponseSchema = z.object({
  active: z.boolean(),
  objective: z.string(),
  status: zeroGoalStatusSchema,
  tokenBudget: z.number().int().positive().optional(),
  stopReason: zeroGoalStopReasonSchema.optional(),
});
export type ZeroGoalResponse = z.infer<typeof zeroGoalResponseSchema>;

export const zeroGoalsContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/goal",
    headers: authHeadersSchema,
    body: zeroGoalCreateRequestSchema,
    responses: {
      201: zeroGoalResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Create a persistent goal for the current thread",
  },
  edit: {
    method: "PATCH",
    path: "/api/zero/goal",
    headers: authHeadersSchema,
    body: zeroGoalEditRequestSchema,
    responses: {
      200: zeroGoalResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Edit the current thread goal's objective or token budget",
  },
  get: {
    method: "GET",
    path: "/api/zero/goal",
    headers: authHeadersSchema,
    responses: {
      200: zeroGoalResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get the current thread goal",
  },
  complete: {
    method: "POST",
    path: "/api/zero/goal/complete",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: zeroGoalResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Mark the current thread goal complete",
  },
  block: {
    method: "POST",
    path: "/api/zero/goal/block",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: zeroGoalResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Pause continuation for the current thread goal",
  },
  resume: {
    method: "POST",
    path: "/api/zero/goal/resume",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: zeroGoalResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Resume continuation for the current thread goal",
  },
});

export type ZeroGoalsContract = typeof zeroGoalsContract;
