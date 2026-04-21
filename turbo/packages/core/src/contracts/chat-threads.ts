import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { runStatusSchema } from "./runs";
import { modelProviderTypeSchema } from "./model-providers";

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
  /**
   * @deprecated Use `agent.id` instead. Will be removed in #10284 once every
   * consumer reads `agent.id` and the UnifyChatThreads flag has fully rolled out.
   * Kept temporarily so existing fixtures still parse during the rollout window.
   */
  agentId: z.string(),
  /**
   * Owning agent snapshot. Always emitted by the server; kept optional on the
   * schema so older fixtures that predate the unified-list rollout still
   * validate until they are migrated (tracked in #10284).
   */
  agent: z
    .object({
      id: z.string(),
      avatarUrl: z.string().nullable(),
    })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /**
   * Read state of the thread's last message. `false` when the thread has no
   * messages yet or the last message has not been marked read.
   * Threads whose last message is archived are filtered out server-side.
   */
  isRead: z.boolean(),
  isArchived: z.boolean(),
  /**
   * True when the thread has at least one non-terminal run
   * (queued / pending / running). Drives the sidebar running indicator,
   * which is mutually exclusive with the unread dot and shares the
   * `ChatThreadReadIndicator` feature switch gate.
   */
  running: z.boolean(),
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
  /**
   * Provider type of the latest run in this thread, if any. Used by the
   * composer's model picker to disable options whose base URL differs from
   * the current session — switching mid-session would break continuity.
   * Null when the thread has no runs yet. Optional so older fixtures/tests
   * that predate the field still validate.
   */
  latestSessionProviderType: modelProviderTypeSchema.nullable().optional(),
  activeRunIds: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  draftContent: z.string().nullable().optional(),
  draftAttachments: z.array(persistedAttachmentSchema).nullable().optional(),
  /**
   * Per-thread model override. Both fields set together or both null.
   * When set, the send route uses this combination (overriding the agent
   * and org defaults) for the next run. Optional for back-compat.
   */
  modelProviderId: z.string().nullable().optional(),
  selectedModel: z.string().nullable().optional(),
});

/**
 * Per-run model selection from the composer. Both fields are required when
 * the object is present; pass `null` to clear the thread's override and fall
 * back to the agent/org default; omit to leave the thread's override unchanged.
 */
const modelSelectionRequestSchema = z.object({
  modelProviderId: z.string().uuid(),
  selectedModel: z.string().min(1),
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
      agentId: z.string().min(1).optional(),
    }),
    responses: {
      200: z.object({ threads: z.array(chatThreadListItemSchema) }),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary:
      "List chat threads. When agentId is omitted, returns every thread the caller owns scoped by orgId.",
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
 * Mark a chat thread as read (Slack-style watermark).
 * Separate contract so it can be served by its own route file.
 */
export const chatThreadMarkReadContract = c.router({
  markRead: {
    method: "POST",
    path: "/api/zero/chat-threads/:id/mark-read",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string() }),
    body: z.object({
      cursor: z.string().datetime().optional(),
    }),
    responses: {
      200: z.object({ lastReadAt: z.string() }),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Mark a chat thread as read up to the given cursor",
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
      /**
       * Per-run model override; persisted on the thread so subsequent runs
       * inherit the same choice. `undefined` = leave current thread override
       * untouched (backward-compat for older clients). `null` = clear the
       * thread override and fall back to agent/org defaults.
       */
      modelSelection: modelSelectionRequestSchema.nullable().optional(),
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
 * Single chat message in a search result.
 * `content` is guaranteed non-null because the search route filters out
 * placeholder rows where content is NULL.
 */
const chatSearchMessageSchema = z.object({
  messageId: z.string(),
  chatThreadId: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.string(),
  sequenceNumber: z.number().nullable(),
  runId: z.string().nullable(),
});

const chatSearchResultSchema = z.object({
  chatThreadId: z.string(),
  agentName: z.string(),
  matchedMessage: chatSearchMessageSchema,
  contextBefore: z.array(chatSearchMessageSchema),
  contextAfter: z.array(chatSearchMessageSchema),
});

/**
 * `hasMore` indicates that the server truncated the result set at `limit`.
 * There is intentionally no cursor/offset: `limit` is capped at 50 (see the
 * query schema below) and chat-message search is a lookup tool, not a bulk
 * export. Callers that hit `hasMore=true` should narrow the query (add
 * `agent`, `since`, or a more specific `keyword`) rather than paginate. If
 * genuine pagination is ever needed, introduce `nextCursor` here — the
 * contract has no external consumers yet, so adding it later is safe.
 */
const chatSearchResponseSchema = z.object({
  results: z.array(chatSearchResultSchema),
  hasMore: z.boolean(),
});

/**
 * Chat search contract (GET /api/zero/chat/search)
 * Searches chat messages within the caller's own threads in the caller's org.
 * Authorization is enforced at the DB query level via userId + orgId filters.
 */
export const chatSearchContract = c.router({
  search: {
    method: "GET",
    path: "/api/zero/chat/search",
    headers: authHeadersSchema,
    query: z.object({
      keyword: z.string().min(1),
      agent: z.string().optional(),
      since: z.coerce.number().optional(),
      limit: z.coerce.number().min(1).max(50).default(20),
      before: z.coerce.number().min(0).max(10).default(0),
      after: z.coerce.number().min(0).max(10).default(0),
    }),
    responses: {
      200: chatSearchResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Search chat messages within caller's org (zero proxy)",
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
  attachFiles: z.array(resolvedAttachFileSchema).optional(),
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
      }),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get paginated chat messages for a thread",
  },
});

export type ChatThreadsContract = typeof chatThreadsContract;
export type ChatThreadByIdContract = typeof chatThreadByIdContract;
export type ChatThreadMarkReadContract = typeof chatThreadMarkReadContract;
export type ChatMessagesContract = typeof chatMessagesContract;
export type ChatThreadMessagesContract = typeof chatThreadMessagesContract;
export type ChatSearchContract = typeof chatSearchContract;
export type ChatSearchResponse = z.infer<typeof chatSearchResponseSchema>;
export type ChatSearchResult = z.infer<typeof chatSearchResultSchema>;
export type ChatSearchMessage = z.infer<typeof chatSearchMessageSchema>;

export {
  chatThreadListItemSchema,
  chatThreadDetailSchema,
  modelSelectionRequestSchema,
  pagedChatMessageSchema,
  summaryEntrySchema,
  persistedAttachmentSchema,
  attachFileSchema,
  resolvedAttachFileSchema,
};

export type ModelSelectionRequest = z.infer<typeof modelSelectionRequestSchema>;

export type SummaryEntry = z.infer<typeof summaryEntrySchema>;
export type ChatThreadListItem = z.infer<typeof chatThreadListItemSchema>;
export type ChatThreadDetail = z.infer<typeof chatThreadDetailSchema>;
export type PagedChatMessage = z.infer<typeof pagedChatMessageSchema>;
export type PersistedAttachment = z.infer<typeof persistedAttachmentSchema>;
export type AttachFile = z.infer<typeof attachFileSchema>;
export type ResolvedAttachFile = z.infer<typeof resolvedAttachFileSchema>;
