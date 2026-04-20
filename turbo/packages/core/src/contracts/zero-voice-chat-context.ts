import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const contextEventSchema = z.object({
  id: z.string(),
  seq: z.number(),
  source: z.string(),
  type: z.string(),
  content: z.string().nullable(),
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

export const zeroVoiceChatContextContract = c.router({
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

  appendEvent: {
    method: "POST",
    path: "/api/zero/voice-chat/:id/context",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().min(1) }),
    body: appendContextEventBodySchema,
    responses: {
      200: z.object({ event: contextEventSchema }),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Append an event to voice-chat shared context",
  },
});

export type ZeroVoiceChatContextContract = typeof zeroVoiceChatContextContract;
export type ContextEvent = z.infer<typeof contextEventSchema>;
export type ContextEventsResponse = z.infer<typeof contextEventsResponseSchema>;
export type AppendContextEventBody = z.infer<
  typeof appendContextEventBodySchema
>;
