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
 * Snapshot of a chat thread's workflow queue: the in-flight automation run (if
 * any), the pending events in FIFO order, and the pause state. Mutations
 * return the same shape so the client can render without a follow-up fetch.
 */
export const workflowQueueResponseSchema = z.object({
  running: workflowQueueRunningRunSchema.nullable(),
  pending: z.array(workflowQueueEventSchema),
  pausedAt: z.string().nullable(),
  pauseReason: z.string().nullable(),
});
export type WorkflowQueueResponse = z.infer<typeof workflowQueueResponseSchema>;

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
    summary: "Read the chat thread's workflow queue state",
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
    summary: "Remove one pending event from its workflow queue",
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
    summary: "Remove all pending events from the thread's workflow queue",
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
    summary: "Pause the thread's workflow queue (events keep enqueueing)",
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
    summary: "Resume the thread's workflow queue and drain it",
  },
});
