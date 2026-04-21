import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const voiceChatSessionBaseSchema = z.object({
  id: z.string(),
  status: z.string(),
});

const voiceChatSessionCreatedSchema = voiceChatSessionBaseSchema.extend({
  runId: z.string(),
  createdAt: z.string(),
  prepared: z.boolean(),
});

const createVoiceChatSessionBodySchema = z.object({
  agentId: z.string().min(1),
});

const voiceChatTokenBodySchema = z.object({
  model: z.string().optional(),
});

const voiceChatTokenResponseSchema = z.object({
  client_secret: z.object({
    value: z.string(),
    expires_at: z.number(),
  }),
});

const okResponseSchema = z.object({ ok: z.literal(true) });

export const zeroVoiceChatSessionsContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/voice-chat",
    headers: authHeadersSchema,
    body: createVoiceChatSessionBodySchema,
    responses: {
      200: z.object({ session: voiceChatSessionCreatedSchema }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Create a new voice-chat session",
  },

  token: {
    method: "POST",
    path: "/api/zero/voice-chat/token",
    headers: authHeadersSchema,
    body: voiceChatTokenBodySchema,
    responses: {
      200: voiceChatTokenResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Mint an ephemeral OpenAI realtime token for voice-chat",
  },

  heartbeat: {
    method: "POST",
    path: "/api/zero/voice-chat/:id/heartbeat",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().min(1) }),
    body: z.object({}),
    responses: {
      200: okResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Keep a voice-chat session alive",
  },

  activate: {
    method: "POST",
    path: "/api/zero/voice-chat/:id/activate",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().min(1) }),
    body: z.object({}),
    responses: {
      200: z.object({ session: voiceChatSessionBaseSchema }),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Activate a preparing voice-chat session",
  },

  end: {
    method: "POST",
    path: "/api/zero/voice-chat/:id/end",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().min(1) }),
    body: z.object({}),
    responses: {
      200: okResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "End a voice-chat session",
  },
});

export type ZeroVoiceChatSessionsContract =
  typeof zeroVoiceChatSessionsContract;
export type VoiceChatSession = z.infer<typeof voiceChatSessionBaseSchema>;
export type VoiceChatSessionCreated = z.infer<
  typeof voiceChatSessionCreatedSchema
>;
export type CreateVoiceChatSessionBody = z.infer<
  typeof createVoiceChatSessionBodySchema
>;
export type VoiceChatTokenBody = z.infer<typeof voiceChatTokenBodySchema>;
export type VoiceChatTokenResponse = z.infer<
  typeof voiceChatTokenResponseSchema
>;
