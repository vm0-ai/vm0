import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const threadIdParams = z.object({ threadId: z.string().min(1) });
const eventIdParams = z.object({ id: z.string().uuid() });

export const workflowQueueEventSchema = z.object({
  id: z.string(),
  automationId: z.string(),
  triggerSource: z.string(),
  triggerBrief: z.string().nullable(),
  createdAt: z.string(),
});
export type WorkflowQueueEvent = z.infer<typeof workflowQueueEventSchema>;

export const workflowQueueRunningRunSchema = z.object({
  runId: z.string(),
  status: z.string(),
  triggerBrief: z.string().nullable(),
  createdAt: z.string(),
});

/**
 * @deprecated Previous-frontend compatibility only. New clients derive pending
 * automation rows from canonical ChatEvents.
 */
export const workflowQueueResponseSchema = z.object({
  running: workflowQueueRunningRunSchema.nullable(),
  pending: z.array(workflowQueueEventSchema),
  pausedAt: z.string().nullable(),
  pauseReason: z.string().nullable(),
});
export type WorkflowQueueResponse = z.infer<typeof workflowQueueResponseSchema>;

/**
 * @deprecated Keep these routes for the previous frontend during the rolling
 * deployment window. New clients use the canonical ChatEvent endpoints.
 */
export const zeroWorkflowQueueContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/chat-threads/:threadId/workflow-queue",
    headers: authHeadersSchema,
    pathParams: threadIdParams,
    responses: {
      200: workflowQueueResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Read the legacy workflow queue projection",
  },
  skipEvent: {
    method: "DELETE",
    path: "/api/zero/workflow-queue/events/:id",
    headers: authHeadersSchema,
    pathParams: eventIdParams,
    body: c.noBody(),
    responses: {
      200: workflowQueueResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Revoke one pending event through the legacy queue API",
  },
  clear: {
    method: "DELETE",
    path: "/api/zero/chat-threads/:threadId/workflow-queue",
    headers: authHeadersSchema,
    pathParams: threadIdParams,
    body: c.noBody(),
    responses: {
      200: workflowQueueResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Revoke pending events through the legacy queue API",
  },
  pause: {
    method: "POST",
    path: "/api/zero/chat-threads/:threadId/workflow-queue/pause",
    headers: authHeadersSchema,
    pathParams: threadIdParams,
    body: c.noBody(),
    responses: {
      200: workflowQueueResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary:
      "Accept the removed pause action for previous-client compatibility",
  },
  resume: {
    method: "POST",
    path: "/api/zero/chat-threads/:threadId/workflow-queue/resume",
    headers: authHeadersSchema,
    pathParams: threadIdParams,
    body: c.noBody(),
    responses: {
      200: workflowQueueResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary:
      "Accept the removed resume action for previous-client compatibility",
  },
});
