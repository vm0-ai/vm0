import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { runStatusSchema } from "./runs";

const c = initContract();

/**
 * File attachment metadata stored alongside user messages.
 * The `id` is the S3 file key — URLs are resolved at query time.
 */
const attachFileSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
});

/** Attach file with a resolved presigned URL, returned to the frontend. */
const resolvedAttachFileSchema = attachFileSchema.extend({
  url: z.string(),
});

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
  /**
   * Read state of the thread's last message. `false` when the thread has no
   * messages yet or the last message has not been marked read.
   * Threads whose last message is archived are filtered out server-side.
   */
  isRead: z.boolean(),
  isArchived: z.boolean(),
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
  attachFiles: z.array(resolvedAttachFileSchema).optional(),
  createdAt: z.string(),
});

const chatThreadDetailSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  agentId: z.string(),
  chatMessages: z.array(storedChatMessageSchema),
  latestSessionId: z.string().nullable(),
  activeRunIds: z.array(z.string()),
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
      attachFiles: z.array(attachFileSchema).optional(),
      // Client-generated UUID used as the user message's primary key.
      // Lets the client render an optimistic row and reconcile with the
      // server row by id — no temp-id swap, no React remount.
      clientMessageId: z.string().uuid().optional(),
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

/**
 * Paginated chat messages contract (/api/zero/chat-threads/:threadId/messages)
 * Cursor-based pagination using message UUID as sinceId.
 */
const pagedChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string().nullable(),
  runId: z.string().optional(),
  error: z.string().optional(),
  status: z.string().optional(),
  createdAt: z.string(),
});

export const chatThreadMessagesContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/chat-threads/:threadId/messages",
    headers: authHeadersSchema,
    pathParams: z.object({ threadId: z.string() }),
    query: z.object({
      sinceId: z.string().uuid().optional(),
      limit: z.coerce.number().min(1).max(50).default(50),
    }),
    responses: {
      200: z.object({
        messages: z.array(pagedChatMessageSchema),
        hasMore: z.boolean(),
      }),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get paginated chat messages for a thread",
  },
});

export type ChatThreadsContract = typeof chatThreadsContract;
export type ChatThreadByIdContract = typeof chatThreadByIdContract;
export type ChatMessagesContract = typeof chatMessagesContract;
export type ChatThreadMessagesContract = typeof chatThreadMessagesContract;

export {
  chatThreadListItemSchema,
  chatThreadDetailSchema,
  pagedChatMessageSchema,
  summaryEntrySchema,
  persistedAttachmentSchema,
  attachFileSchema,
  resolvedAttachFileSchema,
};

export type SummaryEntry = z.infer<typeof summaryEntrySchema>;
export type ChatThreadListItem = z.infer<typeof chatThreadListItemSchema>;
export type ChatThreadDetail = z.infer<typeof chatThreadDetailSchema>;
export type PagedChatMessage = z.infer<typeof pagedChatMessageSchema>;
export type PersistedAttachment = z.infer<typeof persistedAttachmentSchema>;
export type AttachFile = z.infer<typeof attachFileSchema>;
export type ResolvedAttachFile = z.infer<typeof resolvedAttachFileSchema>;
