import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const voiceChatItemRoleSchema = z.enum([
  "user",
  "assistant",
  "task_result",
  "system_note",
]);
export type VoiceChatItemRole = z.infer<typeof voiceChatItemRoleSchema>;

export const voiceChatTaskStatusSchema = z.enum([
  "pending",
  "queued",
  "running",
  "done",
  "failed",
]);
export type VoiceChatTaskStatus = z.infer<typeof voiceChatTaskStatusSchema>;

export const voiceChatReasoningStatusSchema = z.enum(["idle", "running"]);
export type VoiceChatReasoningStatus = z.infer<
  typeof voiceChatReasoningStatusSchema
>;

export const voiceChatSessionSchema = z.object({
  id: z.uuid(),
  orgId: z.string(),
  userId: z.string(),
  agentId: z.uuid().nullable(),
  mode: z.literal("chat"),
  conversationSummary: z.string().nullable(),
  workingTasksSummary: z.string().nullable(),
  finishedTasksSummary: z.string().nullable(),
  summarySeq: z.number().int(),
  summaryVersion: z.number().int(),
  lastSummaryAt: z.string().nullable(),
  createdAt: z.string(),
});
export type VoiceChatSession = z.infer<typeof voiceChatSessionSchema>;

export const voiceChatItemSchema = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  seq: z.number().int(),
  role: voiceChatItemRoleSchema,
  content: z.string().nullable(),
  taskId: z.uuid().nullable(),
  realtimeItemId: z.string().nullable(),
  createdAt: z.string(),
});
export type VoiceChatItem = z.infer<typeof voiceChatItemSchema>;

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
  callId: z.string(),
  prompt: z.string(),
  status: voiceChatTaskStatusSchema,
  result: z.string().nullable(),
  resultUpdatedAt: z.string().nullable(),
  assistantMessages: z.array(voiceChatTaskResultEntrySchema),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type VoiceChatTask = z.infer<typeof voiceChatTaskSchema>;

const tokenResponseSchema = z.object({
  client_secret: z.object({
    value: z.string(),
    expires_at: z.number(),
  }),
});
export type VoiceChatTokenResponse = z.infer<typeof tokenResponseSchema>;

const createSessionBodySchema = z.object({ agentId: z.uuid() });
export type CreateVoiceChatSessionBody = z.infer<
  typeof createSessionBodySchema
>;

const appendItemBodySchema = z.object({
  role: voiceChatItemRoleSchema,
  content: z.string(),
  realtimeItemId: z.string().min(1),
});
export type AppendVoiceChatItemBody = z.infer<typeof appendItemBodySchema>;

const createTaskBodySchema = z.object({
  prompt: z.string().min(1),
  callId: z.string().min(1),
});
export type CreateVoiceChatTaskBody = z.infer<typeof createTaskBodySchema>;

const tokenBodySchema = z.object({
  sessionId: z.uuid(),
  // Client-resolved hint (see platform `resolveAudioConfig`) for the Realtime
  // session's input_audio_noise_reduction. Optional — server defaults to
  // far_field if absent.
  noiseReduction: z.enum(["near_field", "far_field"]).optional(),
});
export type VoiceChatTokenBody = z.infer<typeof tokenBodySchema>;

const okResponseSchema = z.object({ ok: z.literal(true) });

export const zeroVoiceChatContract = c.router({
  createSession: {
    method: "POST",
    path: "/api/zero/voice-chat",
    headers: authHeadersSchema,
    body: createSessionBodySchema,
    responses: {
      200: z.object({
        session: voiceChatSessionSchema,
        recentTaskLogs: z.string(),
        finishedTasksFullText: z.string(),
        talkerInstructions: z.string(),
        talkerInstructionTokens: z.number().int().nonnegative(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Create a new voice-chat session",
  },

  getSession: {
    method: "GET",
    path: "/api/zero/voice-chat/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.uuid() }),
    responses: {
      200: z.object({
        session: voiceChatSessionSchema,
        recentTaskLogs: z.string(),
        finishedTasksFullText: z.string(),
        talkerInstructions: z.string(),
        talkerInstructionTokens: z.number().int().nonnegative(),
      }),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get a voice-chat session with recent task logs",
  },

  listSessions: {
    method: "GET",
    path: "/api/zero/voice-chat",
    headers: authHeadersSchema,
    responses: {
      200: z.object({
        sessions: z.array(voiceChatSessionSchema),
      }),
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List voice-chat sessions for the current user",
  },

  triggerReasoning: {
    method: "POST",
    path: "/api/zero/voice-chat/:id/trigger-reasoning",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.uuid() }),
    body: z.object({}),
    responses: {
      200: okResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary:
      "Queue a reasoner tick for a voice-chat session (respects CAS lock and debounce)",
  },

  appendItem: {
    method: "POST",
    path: "/api/zero/voice-chat/:id/items",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.uuid() }),
    body: appendItemBodySchema,
    responses: {
      200: z.object({ item: voiceChatItemSchema }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Append a conversation item to a voice-chat session",
  },

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
    summary: "Create a task from the Talker's createTask tool call",
  },

  /**
   * Task list for the Trinity sidebar. Returns every still-running task
   * (pending / queued / running) in chronological ASC order, followed by up
   * to the 3 most-recently-finished tasks (done / failed) in finishedAt DESC
   * order. Full replace per Ably tick — no cursor. Older finished tasks drop
   * off; the UI shows them briefly as context and then tidies itself.
   */
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
    summary: "List active + recently-finished tasks for a session",
  },

  token: {
    method: "POST",
    path: "/api/zero/voice-chat/token",
    headers: authHeadersSchema,
    body: tokenBodySchema,
    responses: {
      200: tokenResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Mint an ephemeral OpenAI realtime token for voice-chat",
  },
});

export type ZeroVoiceChatContract = typeof zeroVoiceChatContract;
