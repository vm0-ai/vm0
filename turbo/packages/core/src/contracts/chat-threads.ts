import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { runStatusSchema } from "./runs";

const c = initContract();

const persistedAttachmentSchema = z.object({
  id: z.string(),
  url: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
});

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
  content: z.string().nullable(),
  runId: z.string().optional(),
  error: z.string().optional(),
  status: z.string().optional(),
  createdAt: z.string(),
});

/**
 * Extended schema for the paginated messages list endpoint.
 * Includes `id` (for cursor-based pagination) and `sequenceNumber`
 * (to distinguish event-backed assistant rows from placeholders).
 */
const chatMessageWithIdSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string().nullable(),
  runId: z.string().optional(),
  error: z.string().optional(),
  status: z.string().optional(),
  sequenceNumber: z.number().nullable().optional(),
  createdAt: z.string(),
});

const chatThreadDetailSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  agentId: z.string(),
  chatMessages: z.array(storedChatMessageSchema),
  latestSessionId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  draftContent: z.string().nullable().optional(),
  draftAttachments: z.array(persistedAttachmentSchema).nullable().optional(),
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
      /**
       * Optional ID of a previously scheduled agent run this thread is
       * continuing. When set, the first run created in the thread is seeded
       * with a system prompt that tells the agent to fetch the original run's
       * telemetry via `zero logs <id>`. Later runs inherit the session context
       * and do not get the prompt again.
       */
      sourceScheduleRunId: z.string().uuid().optional(),
    }),
    responses: {
      201: z.object({
        id: z.string(),
        title: z.string().nullable(),
        createdAt: z.string(),
      }),
      401: apiErrorSchema,
      404: apiErrorSchema,
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
  patch: {
    method: "PATCH",
    path: "/api/zero/chat-threads/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string() }),
    body: z.object({
      draftContent: z.string().nullable().optional(),
      draftAttachments: z
        .array(persistedAttachmentSchema)
        .nullable()
        .optional(),
    }),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update chat thread draft content and attachments",
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
 * Chat thread messages list contract (/api/zero/chat-threads/[id]/messages)
 * Paginated read endpoint using sinceId cursor.
 */
export const chatThreadMessagesContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/chat-threads/:id/messages",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string() }),
    query: z.object({
      /**
       * Cursor: return only messages inserted after the message with this ID.
       * When omitted, all messages in the thread are returned.
       */
      sinceId: z.string().uuid().optional(),
    }),
    responses: {
      200: z.object({ messages: z.array(chatMessageWithIdSchema) }),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List messages in a chat thread with optional sinceId cursor",
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
export type ChatThreadMessagesContract = typeof chatThreadMessagesContract;

export {
  chatThreadListItemSchema,
  chatThreadDetailSchema,
  chatMessageWithIdSchema,
  summaryEntrySchema,
  persistedAttachmentSchema,
};

export type SummaryEntry = z.infer<typeof summaryEntrySchema>;
export type ChatThreadListItem = z.infer<typeof chatThreadListItemSchema>;
export type ChatThreadDetail = z.infer<typeof chatThreadDetailSchema>;
export type ChatMessageWithId = z.infer<typeof chatMessageWithIdSchema>;
export type PersistedAttachment = z.infer<typeof persistedAttachmentSchema>;
