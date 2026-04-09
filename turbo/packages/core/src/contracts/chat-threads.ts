import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { runStatusSchema } from "./runs";

const c = initContract();

const chatThreadListItemSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  agentId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const toolSummaryEntrySchema = z.object({
  kind: z.literal("tool"),
  name: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
});

const textSummaryEntrySchema = z.object({
  kind: z.literal("text"),
  text: z.string(),
});

const summaryEntrySchema = z.union([
  z.string(),
  toolSummaryEntrySchema,
  textSummaryEntrySchema,
]);

const storedChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  runId: z.string().optional(),
  error: z.string().optional(),
  summaries: z.array(summaryEntrySchema).optional(),
  createdAt: z.string(),
});

const unsavedRunSchema = z.object({
  runId: z.string(),
  status: z.string(),
  prompt: z.string(),
  error: z.string().nullable(),
  createdAt: z.string(),
});

const chatThreadDetailSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  agentId: z.string(),
  chatMessages: z.array(storedChatMessageSchema),
  latestSessionId: z.string().nullable(),
  unsavedRuns: z.array(unsavedRunSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Chat threads list route contract (/api/chat-threads)
 */
export const chatThreadsContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/chat-threads",
    headers: authHeadersSchema,
    body: z.object({
      agentId: z.string().min(1),
      title: z.string().optional(),
    }),
    responses: {
      201: z.object({
        id: z.string(),
        title: z.string().nullable(),
        createdAt: z.string(),
      }),
      401: apiErrorSchema,
    },
    summary: "Create a new chat thread",
  },
  list: {
    method: "GET",
    path: "/api/zero/chat-threads",
    headers: authHeadersSchema,
    query: z.object({
      agentId: z.string().min(1, "agentId is required"),
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
    path: "/api/zero/chat-threads/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string() }),
    responses: {
      200: chatThreadDetailSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get chat thread detail with messages",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/chat-threads/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string() }),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete a chat thread",
    body: c.noBody(),
  },
});

/**
 * Chat messages contract (/api/zero/chat/messages)
 * Unified endpoint: create thread (if needed) + run + association in one call.
 */
export const chatMessagesContract = c.router({
  send: {
    method: "POST",
    path: "/api/zero/chat/messages",
    headers: authHeadersSchema,
    body: z.object({
      agentId: z.string().min(1),
      prompt: z.string().min(1),
      threadId: z.string().optional(),
      modelProvider: z.string().optional(),
      // Optional for backward compatibility: older clients that omit this field
      // still trigger title generation (server guards with !== false, not === true).
      hasTextContent: z.boolean().optional(),
    }),
    responses: {
      201: z.object({
        runId: z.string(),
        threadId: z.string(),
        status: runStatusSchema,
        createdAt: z.string().optional(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Send a chat message (create thread + run + association)",
  },
});

export type ChatThreadsContract = typeof chatThreadsContract;
export type ChatThreadByIdContract = typeof chatThreadByIdContract;
export type ChatMessagesContract = typeof chatMessagesContract;

export { chatThreadListItemSchema, chatThreadDetailSchema, summaryEntrySchema };

export type SummaryEntry = z.infer<typeof summaryEntrySchema>;
export type ChatThreadListItem = z.infer<typeof chatThreadListItemSchema>;
export type ChatThreadDetail = z.infer<typeof chatThreadDetailSchema>;
