import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const voiceChatCandidateSessionStatusSchema = z.enum([
  "active",
  "ended",
  "timeout",
]);
export type VoiceChatCandidateSessionStatus = z.infer<
  typeof voiceChatCandidateSessionStatusSchema
>;

export const voiceChatCandidateItemRoleSchema = z.enum([
  "user",
  "assistant",
  "task_result",
  "system_note",
]);
export type VoiceChatCandidateItemRole = z.infer<
  typeof voiceChatCandidateItemRoleSchema
>;

export const voiceChatCandidateTaskStatusSchema = z.enum([
  "pending",
  "queued",
  "running",
  "done",
  "failed",
]);
export type VoiceChatCandidateTaskStatus = z.infer<
  typeof voiceChatCandidateTaskStatusSchema
>;

export const voiceChatCandidateReasoningStatusSchema = z.enum([
  "idle",
  "running",
]);
export type VoiceChatCandidateReasoningStatus = z.infer<
  typeof voiceChatCandidateReasoningStatusSchema
>;

export const voiceChatCandidateSessionSchema = z.object({
  id: z.uuid(),
  orgId: z.string(),
  userId: z.string(),
  agentId: z.uuid().nullable(),
  mode: z.literal("chat"),
  status: voiceChatCandidateSessionStatusSchema,
  conversationSummary: z.string().nullable(),
  workingTasksSummary: z.string().nullable(),
  finishedTasksSummary: z.string().nullable(),
  summarySeq: z.number().int(),
  summaryVersion: z.number().int(),
  lastSummaryAt: z.string().nullable(),
  createdAt: z.string(),
  lastHeartbeatAt: z.string(),
  endedAt: z.string().nullable(),
});
export type VoiceChatCandidateSession = z.infer<
  typeof voiceChatCandidateSessionSchema
>;

export const voiceChatCandidateItemSchema = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  seq: z.number().int(),
  role: voiceChatCandidateItemRoleSchema,
  content: z.string().nullable(),
  taskId: z.uuid().nullable(),
  realtimeItemId: z.string().nullable(),
  createdAt: z.string(),
});
export type VoiceChatCandidateItem = z.infer<
  typeof voiceChatCandidateItemSchema
>;

export const voiceChatCandidateTaskResultEntrySchema = z.object({
  type: z.literal("assistant"),
  content: z.string(),
  at: z.string(),
});
export type VoiceChatCandidateTaskResultEntry = z.infer<
  typeof voiceChatCandidateTaskResultEntrySchema
>;

export const voiceChatCandidateTaskSchema = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  runId: z.uuid().nullable(),
  callId: z.string(),
  prompt: z.string(),
  status: voiceChatCandidateTaskStatusSchema,
  assistantMessages: z.array(voiceChatCandidateTaskResultEntrySchema),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type VoiceChatCandidateTask = z.infer<
  typeof voiceChatCandidateTaskSchema
>;

const tokenResponseSchema = z.object({
  client_secret: z.object({
    value: z.string(),
    expires_at: z.number(),
  }),
});
export type VoiceChatCandidateTokenResponse = z.infer<
  typeof tokenResponseSchema
>;

const createSessionBodySchema = z.object({ agentId: z.uuid() });
export type CreateVoiceChatCandidateSessionBody = z.infer<
  typeof createSessionBodySchema
>;

const appendItemBodySchema = z.object({
  role: voiceChatCandidateItemRoleSchema,
  content: z.string(),
  realtimeItemId: z.string().min(1),
});
export type AppendVoiceChatCandidateItemBody = z.infer<
  typeof appendItemBodySchema
>;

const createTaskBodySchema = z.object({
  prompt: z.string().min(1),
  callId: z.string().min(1),
});
export type CreateVoiceChatCandidateTaskBody = z.infer<
  typeof createTaskBodySchema
>;

const tokenBodySchema = z.object({ model: z.string().optional() });
export type VoiceChatCandidateTokenBody = z.infer<typeof tokenBodySchema>;

const okResponseSchema = z.object({ ok: z.literal(true) });

export const zeroVoiceChatCandidateContract = c.router({
  createSession: {
    method: "POST",
    path: "/api/zero/voice-chat-candidate",
    headers: authHeadersSchema,
    body: createSessionBodySchema,
    responses: {
      200: z.object({
        session: voiceChatCandidateSessionSchema,
        recentTaskLogs: z.string(),
        finishedTasksFullText: z.string(),
        talkerInstructions: z.string(),
        talkerInstructionTokens: z.number().int().nonnegative(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Create a new voice-chat-candidate session",
  },

  getSession: {
    method: "GET",
    path: "/api/zero/voice-chat-candidate/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.uuid() }),
    responses: {
      200: z.object({
        session: voiceChatCandidateSessionSchema,
        recentTaskLogs: z.string(),
        finishedTasksFullText: z.string(),
        talkerInstructions: z.string(),
        talkerInstructionTokens: z.number().int().nonnegative(),
      }),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get a voice-chat-candidate session with recent task logs",
  },

  listSessions: {
    method: "GET",
    path: "/api/zero/voice-chat-candidate",
    headers: authHeadersSchema,
    responses: {
      200: z.object({
        sessions: z.array(voiceChatCandidateSessionSchema),
      }),
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List voice-chat-candidate sessions for the current user",
  },

  reenterSession: {
    method: "POST",
    path: "/api/zero/voice-chat-candidate/:id/reenter",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.uuid() }),
    body: z.object({}),
    responses: {
      200: z.object({
        session: voiceChatCandidateSessionSchema,
        recentTaskLogs: z.string(),
        finishedTasksFullText: z.string(),
        talkerInstructions: z.string(),
        talkerInstructionTokens: z.number().int().nonnegative(),
      }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary:
      "Reactivate and load a voice-chat-candidate session, re-computing talker instructions",
  },

  endSession: {
    method: "POST",
    path: "/api/zero/voice-chat-candidate/:id/end",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.uuid() }),
    body: z.object({}),
    responses: {
      200: okResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "End a voice-chat-candidate session",
  },

  heartbeat: {
    method: "POST",
    path: "/api/zero/voice-chat-candidate/:id/heartbeat",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.uuid() }),
    body: z.object({}),
    responses: {
      200: okResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Keep a voice-chat-candidate session alive",
  },

  appendItem: {
    method: "POST",
    path: "/api/zero/voice-chat-candidate/:id/items",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.uuid() }),
    body: appendItemBodySchema,
    responses: {
      200: z.object({ item: voiceChatCandidateItemSchema }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Append a conversation item to a voice-chat-candidate session",
  },

  readItems: {
    method: "GET",
    path: "/api/zero/voice-chat-candidate/:id/items",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.uuid() }),
    query: z.object({ after: z.coerce.number().int().optional() }),
    responses: {
      200: z.object({ items: z.array(voiceChatCandidateItemSchema) }),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Read conversation items from a voice-chat-candidate session",
  },

  createTask: {
    method: "POST",
    path: "/api/zero/voice-chat-candidate/:id/tasks",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.uuid() }),
    body: createTaskBodySchema,
    responses: {
      200: z.object({ task: voiceChatCandidateTaskSchema }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Create a task from the Talker's createTask tool call",
  },

  listTasks: {
    method: "GET",
    path: "/api/zero/voice-chat-candidate/:id/tasks",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.uuid() }),
    responses: {
      200: z.object({ tasks: z.array(voiceChatCandidateTaskSchema) }),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List voice-chat-candidate tasks for a session",
  },

  token: {
    method: "POST",
    path: "/api/zero/voice-chat-candidate/token",
    headers: authHeadersSchema,
    body: tokenBodySchema,
    responses: {
      200: tokenResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Mint an ephemeral OpenAI realtime token for voice-chat-candidate",
  },
});

export type ZeroVoiceChatCandidateContract =
  typeof zeroVoiceChatCandidateContract;
