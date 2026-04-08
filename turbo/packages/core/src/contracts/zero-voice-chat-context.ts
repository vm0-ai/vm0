import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const contextEventSchema = z.object({
  seq: z.number(),
  source: z.string(),
  type: z.string(),
  content: z.string().optional(),
  createdAt: z.string(),
});

const contextEventsResponseSchema = z.object({
  events: z.array(contextEventSchema),
});

const appendContextEventBodySchema = z.object({
  source: z.string(),
  type: z.string(),
  content: z.string().optional(),
});

export const zeroVoiceChatContextGetContract = c.router({
  getEvents: {
    method: "GET",
    path: "/api/zero/voice-chat/:id/context",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().min(1) }),
    query: z.object({ after: z.coerce.number().optional() }),
    responses: {
      200: contextEventsResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get shared context events for a voice-chat session",
  },
});

export const zeroVoiceChatContextAppendContract = c.router({
  appendEvent: {
    method: "POST",
    path: "/api/zero/voice-chat/:id/context",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().min(1) }),
    body: appendContextEventBodySchema,
    responses: {
      200: contextEventSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Append an event to voice-chat shared context",
  },
});

export type ZeroVoiceChatContextGetContract =
  typeof zeroVoiceChatContextGetContract;
export type ZeroVoiceChatContextAppendContract =
  typeof zeroVoiceChatContextAppendContract;
export type ContextEvent = z.infer<typeof contextEventSchema>;
export type ContextEventsResponse = z.infer<typeof contextEventsResponseSchema>;
export type AppendContextEventBody = z.infer<
  typeof appendContextEventBodySchema
>;
