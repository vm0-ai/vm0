import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Public v1 chat-threads surface. Authenticated exclusively via vm0 personal
 * access tokens (`vm0_pat_…`) minted from `/settings/api-keys`. The caller
 * never addresses an agent id — every thread is created under the caller's
 * default agent, and responses omit agent-related fields so the public
 * contract stays narrow.
 */
const v1ThreadSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const v1MessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string().nullable(),
  error: z.string().optional(),
  createdAt: z.string(),
});

export const chatThreadV1GetContract = c.router({
  get: {
    method: "GET",
    path: "/api/v1/chat-threads/:threadId",
    headers: authHeadersSchema,
    pathParams: z.object({ threadId: z.string().uuid() }),
    responses: {
      200: v1ThreadSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get a chat thread",
  },
});

export const chatThreadV1MessagesContract = c.router({
  list: {
    method: "GET",
    path: "/api/v1/chat-threads/:threadId/messages",
    headers: authHeadersSchema,
    pathParams: z.object({ threadId: z.string().uuid() }),
    query: z.object({
      sinceId: z.string().uuid().optional(),
      beforeId: z.string().uuid().optional(),
      limit: z.coerce.number().min(1).max(100).default(50),
    }),
    responses: {
      200: z.object({ messages: z.array(v1MessageSchema) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List messages in a chat thread",
  },
});

export const chatThreadV1SendContract = c.router({
  send: {
    method: "POST",
    path: "/api/v1/chat-threads/messages",
    headers: authHeadersSchema,
    body: z.object({
      prompt: z.string().min(1),
      // When omitted, a new thread is created under the caller's default
      // agent and this becomes its first message. When provided, the
      // message is appended to the existing thread (ownership enforced).
      threadId: z.string().uuid().optional(),
    }),
    responses: {
      201: z.object({
        threadId: z.string(),
        messageId: z.string(),
        createdAt: z.string(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary:
      "Send a chat message — creates a new thread on the caller's default agent when threadId is omitted",
  },
});

export type ChatThreadV1GetContract = typeof chatThreadV1GetContract;
export type ChatThreadV1MessagesContract = typeof chatThreadV1MessagesContract;
export type ChatThreadV1SendContract = typeof chatThreadV1SendContract;

export {
  v1ThreadSchema as chatThreadV1Schema,
  v1MessageSchema as chatMessageV1Schema,
};

export type ChatThreadV1 = z.infer<typeof v1ThreadSchema>;
export type ChatMessageV1 = z.infer<typeof v1MessageSchema>;
