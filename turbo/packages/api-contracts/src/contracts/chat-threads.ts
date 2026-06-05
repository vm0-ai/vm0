import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { runStatusSchema } from "./runs";
import {
  isSupportedRunModel,
  modelProviderCredentialScopeSchema,
  modelProviderTypeSchema,
} from "./model-providers";

const c = initContract();
const MODEL_FIRST_SELECTION_PROVIDER_ID =
  "00000000-0000-4000-8000-000000000000";

/**
 * File attachment metadata stored alongside user messages.
 * The `id` is the attachment id — URLs are resolved at query time.
 */
const attachFileSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
});

/**
 * Attach file returned to the frontend with a resolved URL.
 * `url` is the public artifact CDN URL; consumers may render, cache, or share
 * it freely.
 */
const resolvedAttachFileSchema = attachFileSchema.extend({
  url: z.string(),
});

const chatThreadArtifactGoogleDriveSyncSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("synced"),
    id: z.string(),
    name: z.string(),
    webViewLink: z.string().nullable(),
  }),
  z.object({ status: z.literal("not_synced") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({ status: z.literal("unknown") }),
]);

const chatThreadArtifactFileSchema = resolvedAttachFileSchema.extend({
  createdAt: z.string(),
  googleDriveSync: chatThreadArtifactGoogleDriveSyncSchema.optional(),
});

const chatThreadArtifactRunSchema = z.object({
  runId: z.string(),
  files: z.array(chatThreadArtifactFileSchema),
});

const chatThreadGithubPrCheckRunSchema = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  url: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

const chatThreadGithubPrSchema = z.object({
  repo: z.string(),
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  headSha: z.string(),
  mergeStatus: z.enum(["ready", "conflicts", "blocked", "draft"]).nullable(),
  rollup: z.enum(["success", "failure", "pending", "none", "unknown"]),
  checks: z.array(chatThreadGithubPrCheckRunSchema),
});

/**
 * Attachment metadata persisted in chat_threads.draft_attachments.
 *
 * `url` is the public artifact CDN URL.
 * Historically this stored a 7-day presigned URL that could silently expire
 * while drafts sat in the DB; the public artifact URL removes that footgun.
 */
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
   * Owning agent snapshot emitted by the server for every list row.
   */
  agent: z.object({
    id: z.string(),
    avatarUrl: z.string().nullable(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
  /**
   * Read state of the thread's last message. `false` when the thread has no
   * messages yet or the last message has not been marked read.
   */
  isRead: z.boolean(),
  /**
   * True when the thread has at least one non-terminal run
   * (queued / pending / running). Drives the sidebar running indicator,
   * which is mutually exclusive with the unread dot.
   */
  running: z.boolean(),
  /**
   * True when the thread has draft composer content the user hasn't sent yet
   * (non-empty `draftContent` or one+ `draftAttachments`). Drives the sidebar
   * draft indicator. Optional for back-compat with fixtures predating the field.
   */
  hasDraft: z.boolean().optional(),
  /**
   * Number of schedules linked to this chat thread. Drives the stronger delete
   * confirmation copy before removing a scheduled chat thread. Optional for
   * back-compat with fixtures predating the field.
   */
  scheduleCount: z.number().int().nonnegative().optional(),
  /**
   * ISO timestamp at which the user pinned this thread. Null/undefined means
   * unpinned. Pinned threads sort above unpinned in the sidebar; both groups
   * keep recency order. Optional for back-compat with fixtures that predate
   * the field.
   */
  pinnedAt: z.string().nullable().optional(),
  /**
   * ISO timestamp at which the user manually renamed this thread. Null/undefined
   * means never renamed. When set, automated title generation is suppressed.
   * Optional for back-compat with fixtures that predate the field.
   */
  renamedAt: z.string().nullable().optional(),
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

const presentationGenerationTemplateRequestSchema = z.object({
  type: z.literal("presentation"),
  selection: z.object({
    designSystemId: z.string().min(1),
    templateId: z.string().min(1),
  }),
});

const generationTemplateRequestSchema = z.discriminatedUnion("type", [
  presentationGenerationTemplateRequestSchema,
]);

const pagedChatMessageBaseSchema = z.object({
  id: z.string(),
  content: z.string().nullable(),
  runId: z.string().optional(),
  revokesMessageId: z.string().optional(),
  interruptsRunId: z.string().optional(),
  error: z.string().optional(),
  attachFiles: z.array(resolvedAttachFileSchema).optional(),
  generationTemplate: generationTemplateRequestSchema.optional(),
  // Present on user messages posted by a firing schedule. `scheduleId` links to
  // the schedule detail page; `scheduleTitle` is the schedule name snapshot
  // rendered in place of the prompt text.
  scheduleId: z.string().optional(),
  scheduleTitle: z.string().optional(),
  createdAt: z.string(),
});

const chatMessageRecommendedFollowupSchema = z.object({
  prompt: z.string(),
  kind: z.enum(["talk", "generate"]),
  generationType: z
    .enum(["image", "video", "presentation", "website"])
    .optional(),
});

const chatMessageRecommendedFollowupsSchema = z.preprocess((value) => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const parsed = chatMessageRecommendedFollowupSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}, z.array(chatMessageRecommendedFollowupSchema));

const pagedChatMessageSchema = z.discriminatedUnion("role", [
  pagedChatMessageBaseSchema
    .extend({
      role: z.literal("user"),
    })
    .strict(),
  pagedChatMessageBaseSchema.extend({
    role: z.literal("assistant"),
    status: z.string().optional(),
    runLifecycleEvent: z.enum(["completed", "failed", "cancelled"]).optional(),
    recommendedFollowups: chatMessageRecommendedFollowupsSchema.optional(),
  }),
]);

const chatThreadDetailSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  agentId: z.string(),
  latestSessionId: z.string().nullable(),
  /**
   * ID of the latest message this user has marked read in this thread.
   * Null when the thread has never been explicitly marked read. Optional for
   * back-compat with fixtures/tests that predate the read marker field.
   */
  lastReadMessageId: z.string().nullable().optional(),
  /**
   * Provider type of the latest run in this thread, if any. Used by the
   * composer's model picker to disable options whose base URL differs from
   * the current session — switching mid-session would break continuity.
   * Null when the thread has no runs yet. Optional so older fixtures/tests
   * that predate the field still validate.
   */
  latestSessionProviderType: modelProviderTypeSchema.nullable().optional(),
  activeRunIds: z.array(z.string()),
  /**
   * Active (non-terminal) runs attached to this thread, with live status.
   * Lets the UI distinguish queued runs from running runs without an extra
   * API call. Optional for back-compat with fixtures that predate the field.
   */
  activeRuns: z
    .array(z.object({ id: z.string(), status: z.string() }))
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  draftContent: z.string().nullable().optional(),
  draftAttachments: z.array(persistedAttachmentSchema).nullable().optional(),
  /**
   * Per-thread selected model pin. Provider route fields are retained for
   * backwards-compatible responses but model-first sends re-resolve provider
   * routing from current org policy.
   */
  modelProviderId: z.string().nullable().optional(),
  modelProviderType: modelProviderTypeSchema.nullable().optional(),
  modelProviderCredentialScope: modelProviderCredentialScopeSchema
    .nullable()
    .optional(),
  selectedModel: z.string().nullable().optional(),
  /**
   * ISO timestamp at which the user manually renamed this thread. Null/undefined
   * means never renamed. When set, automated title generation is suppressed.
   * Optional for back-compat with fixtures that predate the field.
   */
  renamedAt: z.string().nullable().optional(),
});

/**
 * Per-run model selection from the composer. Both fields are required when
 * the object is present; pass `null` to clear the thread's override and fall
 * back to the agent/org default; omit to leave the thread's override unchanged.
 */
const modelSelectionRequestSchema = z
  .object({
    modelProviderId: z.string().uuid(),
    selectedModel: z.string().min(1),
  })
  .superRefine((value, ctx) => {
    if (
      value.modelProviderId === MODEL_FIRST_SELECTION_PROVIDER_ID &&
      !isSupportedRunModel(value.selectedModel)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selectedModel"],
        message: "Invalid model selection",
      });
    }
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
      clientThreadId: z.string().uuid().optional(),
      title: z.string().optional(),
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
      /**
       * Maximum number of non-pinned threads to return in this page. Pinned
       * threads are always returned in full and do not count against `limit`.
       * Defaults to 25 (sidebar default).
       */
      limit: z.coerce.number().int().min(1).max(100).optional(),
      /**
       * Opaque cursor returned by a prior page in `nextCursor`. When set,
       * `pinned` is empty (pinned threads are only included on the first
       * page) and `threads` continues from the position after the cursor.
       */
      cursor: z.string().optional(),
    }),
    responses: {
      200: z.object({
        /**
         * All pinned threads in the caller's org, ordered by last activity desc.
         * Always returned in full on the first page (no `cursor`) and empty on
         * subsequent pages — pagination only applies to the non-pinned segment.
         */
        pinned: z.array(chatThreadListItemSchema),
        /**
         * Non-pinned threads for this page, ordered by last activity desc.
         */
        threads: z.array(chatThreadListItemSchema),
        /**
         * True when more non-pinned threads exist beyond this page.
         */
        hasMore: z.boolean(),
        /**
         * Opaque cursor for fetching the next page, or null when `hasMore`
         * is false.
         */
        nextCursor: z.string().nullable(),
        /**
         * Total count of non-pinned threads matching the same scope as this
         * query. Drives the sidebar "All Threads (N)" affordance.
         */
        totalCount: z.number().int(),
      }),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary:
      "List chat threads. When agentId is omitted, returns every thread the caller owns scoped by orgId. Pinned threads are returned in full for the caller's org on the first page; non-pinned threads are cursor-paginated.",
  },
});

/**
 * Chat thread by ID route contract (/api/chat-threads/[id])
 */
const chatThreadIdPathParamsSchema = z.object({ id: z.string().uuid() });
const chatThreadThreadIdPathParamsSchema = z.object({
  threadId: z.string().uuid(),
});

export const chatThreadByIdContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/chat-threads/:id",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    responses: {
      200: chatThreadDetailSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get chat thread detail with messages",
  },
  patch: {
    method: "PATCH",
    path: "/api/zero/chat-threads/:id",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    body: z.object({
      draftContent: z.string().nullable().optional(),
      draftAttachments: z
        .array(persistedAttachmentSchema)
        .nullable()
        .optional(),
    }),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update chat thread draft content and attachments",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/chat-threads/:id",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete a chat thread",
    body: c.noBody(),
  },
});

/**
 * Mark a chat thread as read up to its current latest message.
 * Separate contract so it can be served by its own route file.
 */
export const chatThreadMarkReadContract = c.router({
  markRead: {
    method: "POST",
    path: "/api/zero/chat-threads/:id/mark-read",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    body: c.noBody(),
    responses: {
      200: z.object({
        lastReadMessageId: z.string().nullable(),
        changed: z.boolean(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Mark a chat thread as read up to the latest message",
  },
});

/**
 * Pin / unpin a chat thread. Two separate POST endpoints (no body) instead
 * of widening `chatThreadByIdContract.patch`, which is intentionally narrow
 * (draft fields only). Mirrors the `mark-read` precedent.
 *
 * Split into two contracts because each lives in its own Next.js route
 * folder; `tsr.router` requires every action in a contract to be handled
 * by the same router file.
 */
export const chatThreadPinContract = c.router({
  pin: {
    method: "POST",
    path: "/api/zero/chat-threads/:id/pin",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Pin a chat thread to the top of the sidebar",
  },
});

export const chatThreadUnpinContract = c.router({
  unpin: {
    method: "POST",
    path: "/api/zero/chat-threads/:id/unpin",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Remove the pin from a chat thread",
  },
});

/**
 * Rename a chat thread POST endpoint. Sets both the title and the
 * `renamed_at` timestamp, which suppresses future automated title
 * generation for this thread.
 *
 * Split into a dedicated contract/route so any POST body widening
 * (e.g. future `{ icon, folder }` fields) stays invisible to the
 * unrelated draft PATCH on chatThreadByIdContract.
 */
export const chatThreadRenameContract = c.router({
  rename: {
    method: "POST",
    path: "/api/zero/chat-threads/:id/rename",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    body: z.object({ title: z.string().min(1) }),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Rename a chat thread (suppresses automated title generation)",
  },
});

/**
 * Update a chat thread's model pin. Kept separate from
 * `chatThreadByIdContract.patch`, which intentionally remains draft-only.
 */
export const chatThreadModelSelectionContract = c.router({
  update: {
    method: "POST",
    path: "/api/zero/chat-threads/:id/model-selection",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    body: z.object({
      modelSelection: modelSelectionRequestSchema.nullable(),
    }),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update a chat thread model selection",
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
    body: z.union([
      z.object({
        agentId: z.string().min(1),
        prompt: z.string().min(1),
        threadId: z.string().optional(),
        clientThreadId: z.string().uuid().optional(),
        modelProvider: z.string().optional(),
        /**
         * Per-run model override; persisted on the thread so subsequent runs
         * inherit the same choice. `undefined` = leave current thread override
         * untouched (backward-compat for older clients). `null` = clear the
         * thread override and fall back to agent/org defaults.
         */
        modelSelection: modelSelectionRequestSchema.nullable().optional(),
        generationTemplate: generationTemplateRequestSchema.optional(),
        // Optional for backward compatibility: older clients that omit this field
        // still trigger title generation (server guards with !== false, not === true).
        hasTextContent: z.boolean().optional(),
        attachFiles: z.array(attachFileSchema).optional(),
        // Client-generated UUID used as the user message's primary key.
        // Lets the client render an optimistic row and reconcile with the
        // server row by id — no temp-id swap, no React remount.
        clientMessageId: z.string().uuid().optional(),
        /**
         * Force a new CLI session for this run instead of resuming the
         * thread's latest session. Set by the web composer when the user
         * picks a different `selectedModel` than the one pinned on the
         * thread — the persisted CLI session history was produced by the
         * previous model and is not safe to replay through a different one.
         * Server skips `getLatestSessionIdForThread`, allows the thread pin
         * to be rewritten, and injects prior chat messages into the system
         * prompt so the agent still has the conversation context.
         */
        forceNewSession: z.boolean().optional(),
        // Test-only escape hatch: when the host runner has USE_MOCK_CODEX
        // set (CI default), allow the request to bypass the mock and execute
        // the real codex CLI. Mirrors `debugNoMockClaude` / `debugNoMockCodex`
        // on /api/zero/runs so e2e BYOK smoke tests can exercise the chat
        // entry path end-to-end.
        debugNoMockClaude: z.boolean().optional(),
        debugNoMockCodex: z.boolean().optional(),
        revokesMessageId: z.string().min(1).optional(),
        interruptsRunId: z.undefined().optional(),
      }),
      z.object({
        agentId: z.string().min(1),
        threadId: z.string().min(1),
        revokesMessageId: z.string().min(1),
        clientMessageId: z.string().uuid().optional(),
        prompt: z.undefined().optional(),
        clientThreadId: z.undefined().optional(),
        modelProvider: z.undefined().optional(),
        modelSelection: z.undefined().optional(),
        generationTemplate: z.undefined().optional(),
        hasTextContent: z.undefined().optional(),
        attachFiles: z.undefined().optional(),
        debugNoMockClaude: z.undefined().optional(),
        debugNoMockCodex: z.undefined().optional(),
        interruptsRunId: z.undefined().optional(),
        forceNewSession: z.undefined().optional(),
      }),
      z.object({
        agentId: z.string().min(1),
        threadId: z.string().min(1),
        interruptsRunId: z.string().uuid(),
        clientMessageId: z.string().uuid().optional(),
        prompt: z.undefined().optional(),
        clientThreadId: z.undefined().optional(),
        modelProvider: z.undefined().optional(),
        modelSelection: z.undefined().optional(),
        generationTemplate: z.undefined().optional(),
        hasTextContent: z.undefined().optional(),
        attachFiles: z.undefined().optional(),
        debugNoMockClaude: z.undefined().optional(),
        debugNoMockCodex: z.undefined().optional(),
        revokesMessageId: z.undefined().optional(),
        forceNewSession: z.undefined().optional(),
      }),
    ]),
    responses: {
      201: z.object({
        runId: z.string().nullable(),
        threadId: z.string(),
        status: runStatusSchema.optional(),
        createdAt: z.string().optional(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      422: apiErrorSchema,
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
 * `agentId`, `since`, or a more specific `keyword`) rather than paginate. If
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
      agentId: z.string().uuid().optional(),
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
 * Cursor-based pagination using message UUID as sinceId / beforeId.
 *
 * Query params (mutually exclusive):
 *   sinceId  — forward pagination: messages strictly after this cursor
 *   beforeId — backward pagination: messages strictly before this cursor
 *   (neither) — initial load anchored at the last user message
 *
 * Response includes `hasMore` for initial load and backward pagination so the
 * UI knows whether to offer upward scroll loading.
 */
export const chatThreadMessagesContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/chat-threads/:threadId/messages",
    headers: authHeadersSchema,
    pathParams: chatThreadThreadIdPathParamsSchema,
    query: z.object({
      sinceId: z.string().uuid().optional(),
      beforeId: z.string().uuid().optional(),
      limit: z.coerce.number().min(1).max(50).default(50),
    }),
    responses: {
      200: z.object({
        messages: z.array(pagedChatMessageSchema),
        hasHistoryBefore: z.boolean().optional(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get paginated chat messages for a thread",
  },
});

export const chatThreadArtifactsContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/chat-threads/:threadId/artifacts",
    headers: authHeadersSchema,
    pathParams: chatThreadThreadIdPathParamsSchema,
    responses: {
      200: z.object({
        runs: z.array(chatThreadArtifactRunSchema),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List uploaded files associated with every run in a chat thread",
  },
  syncGoogleDrive: {
    method: "POST",
    path: "/api/zero/chat-threads/:threadId/artifacts",
    headers: authHeadersSchema,
    pathParams: chatThreadThreadIdPathParamsSchema,
    body: z.object({
      runId: z.string(),
      fileId: z.string(),
    }),
    responses: {
      200: z.object({
        id: z.string(),
        name: z.string(),
        webViewLink: z.string().nullable(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Sync a chat artifact file to the user's connected Google Drive",
  },
});

export const chatThreadGithubPrsContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/chat-threads/:threadId/github-prs",
    headers: authHeadersSchema,
    pathParams: z.object({ threadId: z.string() }),
    responses: {
      200: z.object({
        prs: z.array(chatThreadGithubPrSchema),
      }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary:
      "List GitHub pull requests mentioned in a chat thread with their current check-run status.",
  },
});

export type ChatThreadsContract = typeof chatThreadsContract;
export type ChatThreadByIdContract = typeof chatThreadByIdContract;
export type ChatThreadMarkReadContract = typeof chatThreadMarkReadContract;
export type ChatThreadPinContract = typeof chatThreadPinContract;
export type ChatThreadUnpinContract = typeof chatThreadUnpinContract;
export type ChatThreadRenameContract = typeof chatThreadRenameContract;
export type ChatThreadModelSelectionContract =
  typeof chatThreadModelSelectionContract;
export type ChatMessagesContract = typeof chatMessagesContract;
export type ChatThreadMessagesContract = typeof chatThreadMessagesContract;
export type ChatThreadArtifactsContract = typeof chatThreadArtifactsContract;
export type ChatThreadGithubPrsContract = typeof chatThreadGithubPrsContract;
export type ChatSearchContract = typeof chatSearchContract;
export type ChatSearchResponse = z.infer<typeof chatSearchResponseSchema>;
export type ChatSearchResult = z.infer<typeof chatSearchResultSchema>;
export type ChatSearchMessage = z.infer<typeof chatSearchMessageSchema>;

export {
  chatThreadListItemSchema,
  chatThreadDetailSchema,
  modelSelectionRequestSchema,
  generationTemplateRequestSchema,
  presentationGenerationTemplateRequestSchema,
  pagedChatMessageSchema,
  summaryEntrySchema,
  persistedAttachmentSchema,
  attachFileSchema,
  resolvedAttachFileSchema,
  chatThreadArtifactFileSchema,
  chatThreadArtifactGoogleDriveSyncSchema,
  chatThreadArtifactRunSchema,
  chatThreadGithubPrCheckRunSchema,
  chatThreadGithubPrSchema,
};

export type ModelSelectionRequest = z.infer<typeof modelSelectionRequestSchema>;
export type GenerationTemplateRequest = z.infer<
  typeof generationTemplateRequestSchema
>;
export type PresentationGenerationTemplateRequest = z.infer<
  typeof presentationGenerationTemplateRequestSchema
>;

export type SummaryEntry = z.infer<typeof summaryEntrySchema>;
export type ChatThreadListItem = z.infer<typeof chatThreadListItemSchema>;
export type ChatThreadDetail = z.infer<typeof chatThreadDetailSchema>;
export type PagedChatMessage = z.infer<typeof pagedChatMessageSchema>;
export type PersistedAttachment = z.infer<typeof persistedAttachmentSchema>;
export type AttachFile = z.infer<typeof attachFileSchema>;
export type ResolvedAttachFile = z.infer<typeof resolvedAttachFileSchema>;
export type ChatThreadArtifactFile = z.infer<
  typeof chatThreadArtifactFileSchema
>;
export type ChatThreadArtifactGoogleDriveSync = z.infer<
  typeof chatThreadArtifactGoogleDriveSyncSchema
>;
export type ChatThreadArtifactRun = z.infer<typeof chatThreadArtifactRunSchema>;
export type ChatThreadGithubPrCheckRun = z.infer<
  typeof chatThreadGithubPrCheckRunSchema
>;
export type ChatThreadGithubPr = z.infer<typeof chatThreadGithubPrSchema>;
