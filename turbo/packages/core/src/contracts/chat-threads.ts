import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const chatThreadListItemSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  preview: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const storedChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  runId: z.string().optional(),
  createdAt: z.string(),
});

const chatThreadDetailSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  agentComposeId: z.string(),
  chatMessages: z.array(storedChatMessageSchema),
  latestSessionId: z.string().nullable(),
  activeRunId: z.string().nullable(),
  activeRunPrompt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Chat threads list route contract (/api/chat-threads)
 */
export const chatThreadsContract = c.router({
  create: {
    method: "POST",
    path: "/api/chat-threads",
    headers: authHeadersSchema,
    body: z.object({
      agentComposeId: z.string().min(1),
      title: z.string().optional(),
    }),
    responses: {
      201: z.object({ id: z.string(), createdAt: z.string() }),
      401: apiErrorSchema,
    },
    summary: "Create a new chat thread",
  },
  list: {
    method: "GET",
    path: "/api/chat-threads",
    headers: authHeadersSchema,
    query: z.object({
      agentComposeId: z.string().min(1, "agentComposeId is required"),
    }),
    responses: {
      200: z.object({ threads: z.array(chatThreadListItemSchema) }),
      401: apiErrorSchema,
    },
    summary: "List chat threads for an agent",
  },
});

/**
 * Chat thread by ID route contract (/api/chat-threads/[id])
 */
export const chatThreadByIdContract = c.router({
  get: {
    method: "GET",
    path: "/api/chat-threads/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string() }),
    responses: {
      200: chatThreadDetailSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get chat thread detail with messages",
  },
});

/**
 * Chat thread runs route contract (/api/chat-threads/[id]/runs)
 */
export const chatThreadRunsContract = c.router({
  addRun: {
    method: "POST",
    path: "/api/chat-threads/:id/runs",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string() }),
    body: z.object({
      runId: z.string().min(1),
    }),
    responses: {
      204: z.void(),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Associate a run to a chat thread",
  },
});

export type ChatThreadsContract = typeof chatThreadsContract;
export type ChatThreadByIdContract = typeof chatThreadByIdContract;
export type ChatThreadRunsContract = typeof chatThreadRunsContract;

export { chatThreadListItemSchema, chatThreadDetailSchema };

export type ChatThreadListItem = z.infer<typeof chatThreadListItemSchema>;
export type ChatThreadDetail = z.infer<typeof chatThreadDetailSchema>;
