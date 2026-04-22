import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const voiceChatTaskStatusSchema = z.enum([
  "pending",
  "queued",
  "running",
  "done",
  "failed",
]);
export type VoiceChatTaskStatus = z.infer<typeof voiceChatTaskStatusSchema>;

export const voiceChatTaskResultEntrySchema = z.object({
  type: z.literal("assistant"),
  content: z.string(),
  at: z.string(),
});
export type VoiceChatTaskResultEntry = z.infer<
  typeof voiceChatTaskResultEntrySchema
>;

export const voiceChatTaskSchema = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  runId: z.uuid().nullable(),
  prompt: z.string(),
  status: voiceChatTaskStatusSchema,
  result: z.string().nullable(),
  error: z.string().nullable(),
  assistantMessages: z.array(voiceChatTaskResultEntrySchema),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type VoiceChatTask = z.infer<typeof voiceChatTaskSchema>;

const createTaskBodySchema = z.object({
  prompt: z.string().min(1),
});
export type CreateVoiceChatTaskBody = z.infer<typeof createTaskBodySchema>;

export const zeroVoiceChatTasksContract = c.router({
  createTask: {
    method: "POST",
    path: "/api/zero/voice-chat/:id/tasks",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.uuid() }),
    body: createTaskBodySchema,
    responses: {
      200: z.object({ task: voiceChatTaskSchema }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Dispatch a new task from slow-brain to a fresh Zero sandbox run",
  },

  listTasks: {
    method: "GET",
    path: "/api/zero/voice-chat/:id/tasks",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.uuid() }),
    responses: {
      200: z.object({ tasks: z.array(voiceChatTaskSchema) }),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List voice-chat tasks for a session",
  },

  getTask: {
    method: "GET",
    path: "/api/zero/voice-chat/:id/tasks/:taskId",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.uuid(), taskId: z.uuid() }),
    responses: {
      200: z.object({ task: voiceChatTaskSchema }),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get a single voice-chat task",
  },
});

export type ZeroVoiceChatTasksContract = typeof zeroVoiceChatTasksContract;
