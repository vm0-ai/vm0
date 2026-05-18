import { eq, asc, desc, and, sql, inArray, isNotNull } from "drizzle-orm";
import {
  chatMessages,
  type ChatMessageAttachFiles,
} from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { publishUserSignal } from "../../infra/realtime/client";
import { hasAgentSessionId } from "../run-result";
import { recordChatSpan, type ChatSpanDimensions } from "../../infra/metrics";
import { CHAT_REQUEST_OPS, timed } from "./request-span-ops";

/**
 * Number of most-recent prior-context messages consumed by prompt builders
 * (chat send's `previousContext` and chat callback's title context). Rows
 * returned by `getLatestMessagesByThreadId` are already filtered by
 * `content IS NOT NULL` and role IN ('user','assistant') in SQL, so this
 * bound is the exact count of usable rows — not a raw scan size.
 */
export const PREVIOUS_CONTEXT_MESSAGES = 10;

function effectiveChatMessageRunId() {
  return chatMessages.runId;
}

function visibleChatMessageCondition() {
  return sql<boolean>`NOT EXISTS (
      SELECT 1
      FROM ${chatMessages} AS revoker
      WHERE revoker.revokes_message_id = ${chatMessages.id}
    )
    AND NOT (
      ${chatMessages.role} = 'user'
      AND ${chatMessages.runId} IS NULL
      AND ${chatMessages.revokesMessageId} IS NOT NULL
    )
    AND NOT (
      ${chatMessages.role} = 'user'
      AND ${chatMessages.runId} IS NULL
      AND ${chatMessages.interruptsRunId} IS NOT NULL
    )`;
}

const messageRowProjection = {
  id: chatMessages.id,
  role: chatMessages.role,
  content: chatMessages.content,
  runId: effectiveChatMessageRunId(),
  error: chatMessages.error,
  sequenceNumber: chatMessages.sequenceNumber,
  createdAt: chatMessages.createdAt,
  runStatus: agentRuns.status,
  runError: agentRuns.error,
  attachFiles: chatMessages.attachFiles,
  revokesMessageId: chatMessages.revokesMessageId,
  interruptsRunId: chatMessages.interruptsRunId,
  goalRemainingTurns: chatMessages.goalRemainingTurns,
  goalOriginMessageId: chatMessages.goalOriginMessageId,
} as const;

type MessageRow = {
  id: string;
  role: string;
  content: string | null;
  runId: string | null;
  error: string | null;
  sequenceNumber: number | null;
  createdAt: Date;
  runStatus: string | null;
  runError: string | null;
  attachFiles: ChatMessageAttachFiles | null;
  revokesMessageId: string | null;
  interruptsRunId: string | null;
  goalRemainingTurns: number | null;
  goalOriginMessageId: string | null;
};

/**
 * Narrower row shape returned by `getLatestMessagesByThreadId`. The SQL
 * query enforces `role IN ('user','assistant')` and `content IS NOT NULL`,
 * so callers can treat those fields as already narrowed without reaching
 * for `as` casts.
 */
type PromptContextMessageRow = Omit<MessageRow, "role" | "content"> & {
  role: "user" | "assistant";
  content: string;
};

/**
 * Insert a chat message (user row on send, or assistant row on terminal
 * callback / direct integration) and fan out the `chatThreadMessageCreated`
 * realtime signal to the thread owner.
 *
 * When `id` is provided, it is used as the primary key so the client can
 * reconcile an optimistic row by matching on id. Otherwise the DB default
 * (`defaultRandom()`) is used.
 *
 * Publishing the signal here (instead of at each call site) ensures the
 * cancel / failure paths — which insert via the chat callback — also notify
 * the frontend, so the cancelled message surfaces without a page refresh.
 */
export async function insertChatMessage(params: {
  chatThreadId: string;
  userId: string;
  role: "user" | "assistant";
  content: string | null;
  runId: string | null;
  error?: string | null;
  attachFiles?: ChatMessageAttachFiles;
  revokesMessageId?: string | null;
  interruptsRunId?: string | null;
  goalRemainingTurns?: number | null;
  goalOriginMessageId?: string | null;
  id?: string;
  spanDims?: ChatSpanDimensions;
}): Promise<{ id: string; createdAt: Date }> {
  const { result: insertedRow, ms: insertMs } = await timed(async () => {
    return globalThis.services.db
      .insert(chatMessages)
      .values({
        ...(params.id ? { id: params.id } : {}),
        chatThreadId: params.chatThreadId,
        role: params.role,
        content: params.content,
        runId: params.runId,
        revokesMessageId: params.revokesMessageId ?? null,
        interruptsRunId: params.interruptsRunId ?? null,
        goalRemainingTurns: params.goalRemainingTurns ?? null,
        goalOriginMessageId: params.goalOriginMessageId ?? null,
        error: params.error ?? null,
        attachFiles: params.attachFiles ?? null,
      })
      .returning({ id: chatMessages.id, createdAt: chatMessages.createdAt });
  });
  const [row] = insertedRow;
  if (params.spanDims) {
    recordChatSpan(
      CHAT_REQUEST_OPS.insert_chat_message_insert,
      insertMs,
      params.spanDims,
    );
  }

  if (!row) {
    throw new Error("Failed to insert chat message");
  }

  const { ms: publishSignalMs } = await timed(async () => {
    await publishUserSignal(
      [params.userId],
      `chatThreadMessageCreated:${params.chatThreadId}`,
    );
  });
  if (params.spanDims) {
    recordChatSpan(
      CHAT_REQUEST_OPS.insert_chat_message_publish_signal,
      publishSignalMs,
      params.spanDims,
    );
  }

  const { ms: publishListMs } = await timed(async () => {
    await publishThreadListChanged(params.userId);
  });
  if (params.spanDims) {
    recordChatSpan(
      CHAT_REQUEST_OPS.insert_chat_message_publish_list,
      publishListMs,
      params.spanDims,
    );
  }

  return row;
}

/**
 * Idempotently insert assistant-visible rows keyed by agent event sequence.
 * Normal callers pass agent "assistant" events; the chat callback can also
 * pass terminal "result" content for result-only CLI outputs.
 *
 * Keyed by `(run_id, sequence_number)` with a unique index, so
 * duplicate deliveries (from retries, the event consumer racing the
 * callback's final sweep, or multiple consumers re-processing the same
 * batch) collapse to a single row — no advisory lock, no Axiom re-query.
 *
 * Out-of-order arrival is also safe: each insert is independent, and
 * read queries recover the intended order via `sequence_number`.
 *
 * Returns the number of rows actually inserted (conflicting rows count 0).
 */
export async function insertAssistantEventMessages(
  runId: string,
  threadId: string,
  userId: string,
  items: { sequenceNumber: number; content: string; runEventId?: string }[],
): Promise<number> {
  if (items.length === 0) {
    return 0;
  }

  const rows = await globalThis.services.db
    .insert(chatMessages)
    .values(
      items.map((item) => {
        return {
          chatThreadId: threadId,
          runId,
          role: "assistant" as const,
          content: item.content,
          sequenceNumber: item.sequenceNumber,
          runEventId: item.runEventId ?? null,
        };
      }),
    )
    .onConflictDoNothing({
      target: [chatMessages.runId, chatMessages.sequenceNumber],
    })
    .returning({ id: chatMessages.id });

  if (rows.length > 0) {
    await publishUserSignal([userId], `chatThreadMessageCreated:${threadId}`);
    await publishThreadListChanged(userId);
  }

  return rows.length;
}

/**
 * Resolve the chat_thread_id and owner user_id for a run from the zero_runs
 * table. Returns null when the run is not tied to a chat thread (e.g.,
 * non-chat triggers like cron/schedule), so event consumers can silently skip it.
 */
export async function getChatThreadIdForRun(
  runId: string,
): Promise<{ chatThreadId: string; userId: string } | null> {
  const [row] = await globalThis.services.db
    .select({
      chatThreadId: zeroRuns.chatThreadId,
      userId: chatThreads.userId,
    })
    .from(zeroRuns)
    .innerJoin(chatThreads, eq(zeroRuns.chatThreadId, chatThreads.id))
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  if (!row?.chatThreadId) return null;
  return { chatThreadId: row.chatThreadId, userId: row.userId };
}

/**
 * Emit the `chatThreadRunUpdated:${threadId}` realtime signal so chat
 * subscribers reload the thread when a run transitions to a terminal state.
 *
 * Reads the authoritative `zero_runs.chatThreadId` mapping rather than
 * reverse-looking-up `chat_messages`, so the signal fires even when no
 * assistant row has been written yet (e.g., cancel before the first token).
 *
 * No-op for non-chat runs (cron / schedule triggers).
 */
export async function publishChatThreadRunUpdated(
  runId: string,
): Promise<void> {
  const chatThread = await getChatThreadIdForRun(runId);
  if (!chatThread) return;
  await publishUserSignal(
    [chatThread.userId],
    `chatThreadRunUpdated:${chatThread.chatThreadId}`,
  );
  await publishThreadListChanged(chatThread.userId);
}

/**
 * Fire the user-level "thread list shape changed" signal. The sidebar
 * subscribes to this topic and reloads the full list on any delivery —
 * payload is intentionally empty because the server is authoritative and
 * the client already has a cheap list endpoint to re-fetch.
 */
export async function publishThreadListChanged(userId: string): Promise<void> {
  await publishUserSignal([userId], "threadListChanged");
}

/**
 * Get all message events for a thread with run status, ordered by createdAt ASC.
 *
 * Unbounded — only callers that truly need the full thread (e.g., the SPA's
 * thread-bootstrap endpoint) should use this. This intentionally does not
 * apply visibility/revoke filters: chat message APIs are the append-only event
 * stream, and clients derive their own display projection. Prompt-context
 * builders must use `getLatestMessagesByThreadId`, which bounds the scan to
 * `LIMIT N` and pushes usability filters into SQL so thread length does not
 * compound latency on every send.
 */
export async function getMessagesByThreadId(
  chatThreadId: string,
): Promise<MessageRow[]> {
  return globalThis.services.db
    .select(messageRowProjection)
    .from(chatMessages)
    .leftJoin(agentRuns, eq(agentRuns.id, chatMessages.runId))
    .where(eq(chatMessages.chatThreadId, chatThreadId))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.sequenceNumber));
}

/**
 * Fetch the latest `limit` messages for a thread that are eligible for
 * prompt-context inclusion, returned in chronological order.
 *
 * Filters applied in SQL (so `limit` bounds the usable output, not the raw
 * scan):
 *  - `content IS NOT NULL` — placeholder assistant rows are excluded
 *  - `role IN ('user','assistant')` — defensive; matches the downstream cast
 *  - optional `excludeRunId` — chat callback excludes the current run's own
 *    rows so the title-context window only contains prior rounds
 *
 * Using `ORDER BY createdAt DESC LIMIT N` then `reverse()` in memory keeps
 * the query driven by `idx_chat_messages_thread_created` (thread_id,
 * created_at).
 */
export async function getLatestMessagesByThreadId(
  chatThreadId: string,
  limit: number,
  options?: { excludeRunId?: string },
): Promise<PromptContextMessageRow[]> {
  const conditions = [
    eq(chatMessages.chatThreadId, chatThreadId),
    isNotNull(chatMessages.content),
    inArray(chatMessages.role, ["user", "assistant"]),
    visibleChatMessageCondition(),
  ];
  if (options?.excludeRunId !== undefined) {
    conditions.push(
      sql`(${effectiveChatMessageRunId()} IS NULL OR ${effectiveChatMessageRunId()} != ${options.excludeRunId})`,
    );
  }

  const rows = await globalThis.services.db
    .select(messageRowProjection)
    .from(chatMessages)
    .leftJoin(agentRuns, eq(agentRuns.id, chatMessages.runId))
    .where(and(...conditions))
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.sequenceNumber))
    .limit(limit);
  // SQL guarantees role ∈ {'user','assistant'} and content IS NOT NULL, so
  // narrow once here instead of pushing the cast out to every caller.
  return rows.reverse().map((row) => {
    return {
      ...row,
      role: row.role as "user" | "assistant",
      content: row.content as string,
    };
  });
}

/**
 * Fetch chat message events for a thread, rendered in natural chronological order
 * (createdAt ASC, sequenceNumber ASC).
 *
 * - When `sinceId` is provided: returns up to `limit` messages strictly after
 *   the cursor, forward-paginating through the thread.
 * - When `beforeId` is provided: returns up to `limit` messages strictly before
 *   the cursor, re-sorted ASC for prepend-on-load-history rendering.
 * - When neither cursor is provided: returns the *latest* `limit` messages,
 *   re-sorted ASC for rendering. This anchors the initial view at the most
 *   recent activity rather than the thread's beginning.
 */
export async function getPagedMessages(
  chatThreadId: string,
  sinceId: string | undefined,
  beforeId: string | undefined,
  limit: number,
): Promise<{
  messages: Array<{
    id: string;
    role: string;
    content: string | null;
    runId: string | null;
    error: string | null;
    sequenceNumber: number | null;
    createdAt: Date;
    runStatus: string | null;
    runError: string | null;
    attachFiles: ChatMessageAttachFiles | null;
    revokesMessageId: string | null;
    interruptsRunId: string | null;
  }>;
  hasHistoryBefore: boolean;
}> {
  const db = globalThis.services.db;

  const columns = {
    id: chatMessages.id,
    role: chatMessages.role,
    content: chatMessages.content,
    runId: effectiveChatMessageRunId(),
    error: chatMessages.error,
    sequenceNumber: chatMessages.sequenceNumber,
    createdAt: chatMessages.createdAt,
    runStatus: agentRuns.status,
    runError: agentRuns.error,
    attachFiles: chatMessages.attachFiles,
    revokesMessageId: chatMessages.revokesMessageId,
    interruptsRunId: chatMessages.interruptsRunId,
  };

  if (sinceId !== undefined && beforeId !== undefined) {
    throw new Error("sinceId and beforeId are mutually exclusive");
  }

  if (sinceId === undefined && beforeId === undefined) {
    const rows = await db
      .select(columns)
      .from(chatMessages)
      .leftJoin(agentRuns, eq(agentRuns.id, chatMessages.runId))
      .where(eq(chatMessages.chatThreadId, chatThreadId))
      .orderBy(desc(chatMessages.createdAt), desc(chatMessages.sequenceNumber))
      .limit(limit + 1);
    const hasHistoryBefore = rows.length > limit;
    return {
      messages: rows.slice(0, limit).reverse(),
      hasHistoryBefore,
    };
  }

  const cursorId = sinceId ?? beforeId;
  const cursorAfterCondition = sql`(
    ${chatMessages.createdAt},
    COALESCE(${chatMessages.sequenceNumber}, -1)
  ) > (
    SELECT ${chatMessages.createdAt}, COALESCE(${chatMessages.sequenceNumber}, -1)
    FROM ${chatMessages}
    WHERE ${chatMessages.id} = ${cursorId}
  )`;
  const cursorBeforeCondition = sql`(
    ${chatMessages.createdAt},
    COALESCE(${chatMessages.sequenceNumber}, -1)
  ) < (
    SELECT ${chatMessages.createdAt}, COALESCE(${chatMessages.sequenceNumber}, -1)
    FROM ${chatMessages}
    WHERE ${chatMessages.id} = ${cursorId}
  )`;

  if (sinceId !== undefined) {
    return {
      messages: await db
        .select(columns)
        .from(chatMessages)
        .leftJoin(agentRuns, eq(agentRuns.id, chatMessages.runId))
        .where(
          and(
            eq(chatMessages.chatThreadId, chatThreadId),
            cursorAfterCondition,
          ),
        )
        .orderBy(asc(chatMessages.createdAt), asc(chatMessages.sequenceNumber))
        .limit(limit),
      hasHistoryBefore: false,
    };
  }

  const rows = await db
    .select(columns)
    .from(chatMessages)
    .leftJoin(agentRuns, eq(agentRuns.id, chatMessages.runId))
    .where(
      and(eq(chatMessages.chatThreadId, chatThreadId), cursorBeforeCondition),
    )
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.sequenceNumber))
    .limit(limit + 1);

  const hasHistoryBefore = rows.length > limit;
  return {
    messages: rows.slice(0, limit).reverse(),
    hasHistoryBefore,
  };
}

/**
 * Get the latest session ID for a thread by finding the most recent
 * run's result.agentSessionId via zero_runs → agent_runs.
 * Used for runner session continuity (continuedFromSessionId).
 */
export async function getLatestSessionIdForThread(
  chatThreadId: string,
): Promise<string | undefined> {
  const rows = await globalThis.services.db
    .select({
      result: agentRuns.result,
    })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(zeroRuns.id, agentRuns.id))
    .where(eq(zeroRuns.chatThreadId, chatThreadId))
    .orderBy(desc(agentRuns.createdAt))
    .limit(5);

  for (const row of rows) {
    if (hasAgentSessionId(row.result)) {
      return row.result.agentSessionId;
    }
  }
  return undefined;
}

/**
 * Row shape returned by `getIncompleteRoundsSinceLastSuccess`. Kept here (and
 * exported) so the prompt formatter can type its input without re-declaring
 * the shape.
 */
type IncompleteRoundStatus = "cancelled" | "failed" | "timeout";

interface IncompleteRoundRow {
  runId: string;
  runStatus: IncompleteRoundStatus;
  role: "user" | "assistant";
  content: string | null;
  error: string | null;
  attachFiles: ChatMessageAttachFiles | null;
  createdAt: Date;
  sequenceNumber: number | null;
}

function isIncompleteRunStatus(
  value: string | null,
): value is IncompleteRoundStatus {
  return value === "cancelled" || value === "failed" || value === "timeout";
}

/**
 * Return chat_messages rows from rounds the CLI session does NOT carry: runs
 * that cancelled / failed / timed out after the most recent run whose
 * `result.agentSessionId` was written. Ordered chronologically; grouped by
 * runId in the caller (each row keeps its runId so the formatter can group).
 *
 * When the thread has no session-producing run yet, every incomplete round in
 * the thread is returned (the CLI session is empty, so nothing is duplicated).
 *
 * Caps at the most recent `MAX_ROUNDS` distinct runIds to guard against a
 * pathological cancel loop ballooning the prompt.
 */
export async function getIncompleteRoundsSinceLastSuccess(
  chatThreadId: string,
  options?: { maxRounds?: number },
): Promise<IncompleteRoundRow[]> {
  const maxRounds = options?.maxRounds ?? 20;

  // Single query with a session-anchor subquery:
  //  - anchor: MAX(created_at) among this thread's rows whose run persisted
  //    a string-typed agentSessionId — matches `hasAgentSessionId` exactly.
  //  - outer scan: only rows strictly after that anchor with an incomplete
  //    run status and a valid role, already sorted for the caller.
  //
  // INNER JOIN is equivalent to the old LEFT JOIN + `isIncompleteRunStatus(
  // null) === false` discard, because the status filter only matches when
  // a matching `agent_runs` row exists. Pushing the status/role filters
  // into SQL lets Postgres skip the full-thread scan of `agent_runs.result`
  // JSONB that the old "load every row + JS scan" pattern required.
  const rows = await globalThis.services.db
    .select({
      runId: chatMessages.runId,
      role: chatMessages.role,
      content: chatMessages.content,
      error: chatMessages.error,
      attachFiles: chatMessages.attachFiles,
      createdAt: chatMessages.createdAt,
      sequenceNumber: chatMessages.sequenceNumber,
      runStatus: agentRuns.status,
    })
    .from(chatMessages)
    .innerJoin(agentRuns, eq(agentRuns.id, chatMessages.runId))
    .where(
      and(
        eq(chatMessages.chatThreadId, chatThreadId),
        visibleChatMessageCondition(),
        inArray(agentRuns.status, ["cancelled", "failed", "timeout"]),
        inArray(chatMessages.role, ["user", "assistant"]),
        sql`${chatMessages.createdAt} > COALESCE(
          (
            SELECT MAX(cm2.created_at)
            FROM chat_messages cm2
            INNER JOIN agent_runs ar2 ON ar2.id = cm2.run_id
            WHERE cm2.chat_thread_id = ${chatThreadId}
              AND NOT EXISTS (
                SELECT 1
                FROM chat_messages revoker2
                WHERE revoker2.revokes_message_id = cm2.id
              )
              AND ar2.result ? 'agentSessionId'
              AND jsonb_typeof(ar2.result->'agentSessionId') = 'string'
          ),
          '-infinity'::timestamptz
        )`,
      ),
    )
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.sequenceNumber));

  const candidates: IncompleteRoundRow[] = [];
  for (const row of rows) {
    if (row.runId === null) continue;
    if (!isIncompleteRunStatus(row.runStatus)) continue;
    if (row.role !== "user" && row.role !== "assistant") continue;
    candidates.push({
      runId: row.runId,
      runStatus: row.runStatus,
      role: row.role,
      content: row.content,
      error: row.error,
      attachFiles: row.attachFiles,
      createdAt: row.createdAt,
      sequenceNumber: row.sequenceNumber,
    });
  }

  if (candidates.length === 0) return [];

  const runIdOrder: string[] = [];
  const seen = new Set<string>();
  for (const row of candidates) {
    if (!seen.has(row.runId)) {
      seen.add(row.runId);
      runIdOrder.push(row.runId);
    }
  }

  if (runIdOrder.length <= maxRounds) return candidates;

  const keep = new Set(runIdOrder.slice(runIdOrder.length - maxRounds));
  return candidates.filter((row) => {
    return keep.has(row.runId);
  });
}
