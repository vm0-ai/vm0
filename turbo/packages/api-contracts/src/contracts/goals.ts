import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const goalStatusSchema = z.enum([
  "active",
  "paused",
  "blocked",
  "complete",
]);
export type GoalStatus = z.infer<typeof goalStatusSchema>;

export const goalEventSchema = z.union([
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
export type GoalEvent = z.infer<typeof goalEventSchema>;

export const goalCreateRequestSchema = z.object({
  objective: z.string().min(1).max(20_000),
});
export type GoalCreateRequest = z.infer<typeof goalCreateRequestSchema>;

export const goalEditRequestSchema = z.object({
  objective: z.string().min(1).max(20_000),
});
export type GoalEditRequest = z.infer<typeof goalEditRequestSchema>;

export const goalResponseSchema = z.object({
  objective: z.string(),
  objectiveBrief: z.string(),
  status: goalStatusSchema,
});
export type GoalResponse = z.infer<typeof goalResponseSchema>;

const chatThreadGoalParamsSchema = z.object({
  threadId: z.string().min(1),
});

export const goalsContract = c.router({
  create: {
    method: "POST",
    path: "/api/okou/goal",
    headers: authHeadersSchema,
    body: goalCreateRequestSchema,
    responses: {
      201: goalResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Create a persistent goal for the current thread",
  },
  edit: {
    method: "PATCH",
    path: "/api/okou/goal",
    headers: authHeadersSchema,
    body: goalEditRequestSchema,
    responses: {
      200: goalResponseSchema,
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
    path: "/api/okou/goal",
    headers: authHeadersSchema,
    responses: {
      200: goalResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Get the current thread goal",
  },
  getForChatThread: {
    method: "GET",
    path: "/api/okou/chat-threads/:threadId/goal",
    headers: authHeadersSchema,
    pathParams: chatThreadGoalParamsSchema,
    responses: {
      200: goalResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Get a chat thread goal",
  },
  complete: {
    method: "POST",
    path: "/api/okou/goal/complete",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: goalResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Mark the current thread goal complete",
  },
  block: {
    method: "POST",
    path: "/api/okou/goal/block",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: goalResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Mark the current thread goal blocked",
  },
  pause: {
    method: "POST",
    path: "/api/okou/goal/pause",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: goalResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Pause the current thread goal",
  },
  pauseForChatThread: {
    method: "POST",
    path: "/api/okou/chat-threads/:threadId/goal/pause",
    headers: authHeadersSchema,
    pathParams: chatThreadGoalParamsSchema,
    body: c.noBody(),
    responses: {
      200: goalResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Pause a chat thread goal",
  },
  resume: {
    method: "POST",
    path: "/api/okou/goal/resume",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: goalResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Resume continuation for the current thread goal",
  },
  clear: {
    method: "DELETE",
    path: "/api/okou/goal",
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

export type GoalsContract = typeof goalsContract;
