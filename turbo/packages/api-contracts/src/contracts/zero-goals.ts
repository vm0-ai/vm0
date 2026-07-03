import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const zeroGoalStatusSchema = z.enum([
  "active",
  "paused",
  "blocked",
  "complete",
]);
export type ZeroGoalStatus = z.infer<typeof zeroGoalStatusSchema>;

export const zeroGoalEventSchema = z.union([
  z.object({
    type: z.literal("state"),
    status: z.literal("active"),
    objectiveBrief: z.string().min(1),
  }),
  z.object({
    type: z.literal("state"),
    status: z.enum(["paused", "blocked", "complete"]),
  }),
  z.object({ type: z.literal("cleared") }),
]);
export type ZeroGoalEvent = z.infer<typeof zeroGoalEventSchema>;

export const zeroGoalCreateRequestSchema = z.object({
  objective: z.string().min(1).max(20_000),
});
export type ZeroGoalCreateRequest = z.infer<typeof zeroGoalCreateRequestSchema>;

export const zeroGoalEditRequestSchema = z.object({
  objective: z.string().min(1).max(20_000),
});
export type ZeroGoalEditRequest = z.infer<typeof zeroGoalEditRequestSchema>;

export const zeroGoalResponseSchema = z.object({
  objective: z.string(),
  objectiveBrief: z.string(),
  status: zeroGoalStatusSchema,
});
export type ZeroGoalResponse = z.infer<typeof zeroGoalResponseSchema>;

const chatThreadGoalParamsSchema = z.object({
  threadId: z.string().min(1),
});

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
      409: apiErrorSchema,
    },
    summary: "Edit the current thread goal objective",
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
      409: apiErrorSchema,
    },
    summary: "Get the current thread goal",
  },
  getForChatThread: {
    method: "GET",
    path: "/api/zero/chat-threads/:threadId/goal",
    headers: authHeadersSchema,
    pathParams: chatThreadGoalParamsSchema,
    responses: {
      200: zeroGoalResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Get a chat thread goal",
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
      409: apiErrorSchema,
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
      409: apiErrorSchema,
    },
    summary: "Mark the current thread goal blocked",
  },
  pause: {
    method: "POST",
    path: "/api/zero/goal/pause",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: zeroGoalResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Pause the current thread goal",
  },
  pauseForChatThread: {
    method: "POST",
    path: "/api/zero/chat-threads/:threadId/goal/pause",
    headers: authHeadersSchema,
    pathParams: chatThreadGoalParamsSchema,
    body: c.noBody(),
    responses: {
      200: zeroGoalResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Pause a chat thread goal",
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
  clear: {
    method: "DELETE",
    path: "/api/zero/goal",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: z.object({ cleared: z.literal(true) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Clear the current thread goal",
  },
});

export type ZeroGoalsContract = typeof zeroGoalsContract;
