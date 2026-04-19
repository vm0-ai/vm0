import { eq, asc, desc, and, sql } from "drizzle-orm";
import {
  chatMessages,
  type ChatMessageAttachFiles,
} from "../../../db/schema/chat-message";
import { chatThreads } from "../../../db/schema/chat-thread";
import { agentRuns } from "../../../db/schema/agent-run";
import { zeroRuns } from "../../../db/schema/zero-run";
import { publishUserSignal } from "../../infra/realtime/client";

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
  id?: string;
}): Promise<{ id: string; createdAt: Date }> {
  const [row] = await globalThis.services.db
    .insert(chatMessages)
    .values({
      ...(params.id ? { id: params.id } : {}),
      chatThreadId: params.chatThreadId,
      role: params.role,
      content: params.content,
      runId: params.runId,
      error: params.error ?? null,
      attachFiles: params.attachFiles ?? null,
    })
    .returning({ id: chatMessages.id, createdAt: chatMessages.createdAt });

  if (!row) {
    throw new Error("Failed to insert chat message");
  }

  await publishUserSignal(
    [params.userId],
    `chatThreadMessageCreated:${params.chatThreadId}`,
  );
  await publishThreadListChanged(params.userId);

  return row;
}

/**
 * Idempotently insert one assistant row per agent "assistant" event.
 *
 * Keyed by `(run_id, sequence_number)` with a partial unique index, so
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
 * Get all messages for a thread with run status, ordered by createdAt ASC.
 */
export async function getMessagesByThreadId(chatThreadId: string): Promise<
  Array<{
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
  }>
> {
  return globalThis.services.db
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
      runId: chatMessages.runId,
      error: chatMessages.error,
      sequenceNumber: chatMessages.sequenceNumber,
      createdAt: chatMessages.createdAt,
      runStatus: agentRuns.status,
      runError: agentRuns.error,
      attachFiles: chatMessages.attachFiles,
    })
    .from(chatMessages)
    .leftJoin(agentRuns, eq(chatMessages.runId, agentRuns.id))
    .where(eq(chatMessages.chatThreadId, chatThreadId))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.sequenceNumber));
}

/**
 * Get messages for a thread after a given cursor message, ordered by
 * (created_at ASC, sequence_number ASC).
 *
 * Cursor-based paginated query for chat messages.
 * Returns messages after the given sinceId in natural order
 * (createdAt ASC, sequenceNumber ASC). When sinceId is undefined,
 * returns from the beginning of the thread.
 *
 * Fetches limit+1 rows to determine hasMore without an extra COUNT query.
 */
export async function getMessagesSince(
  chatThreadId: string,
  sinceId: string | undefined,
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
  }>;
  hasMore: boolean;
}> {
  const db = globalThis.services.db;

  let cursorCondition;
  if (sinceId) {
    cursorCondition = sql`(
      ${chatMessages.createdAt},
      COALESCE(${chatMessages.sequenceNumber}, -1)
    ) > (
      SELECT ${chatMessages.createdAt}, COALESCE(${chatMessages.sequenceNumber}, -1)
      FROM ${chatMessages}
      WHERE ${chatMessages.id} = ${sinceId}
    )`;
  }

  const conditions = [eq(chatMessages.chatThreadId, chatThreadId)];
  if (cursorCondition) {
    conditions.push(cursorCondition);
  }

  const rows = await db
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
      runId: chatMessages.runId,
      error: chatMessages.error,
      sequenceNumber: chatMessages.sequenceNumber,
      createdAt: chatMessages.createdAt,
      runStatus: agentRuns.status,
      runError: agentRuns.error,
    })
    .from(chatMessages)
    .leftJoin(agentRuns, eq(chatMessages.runId, agentRuns.id))
    .where(and(...conditions))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.sequenceNumber))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const messages = hasMore ? rows.slice(0, limit) : rows;

  return { messages, hasMore };
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

function hasAgentSessionId(
  value: unknown,
): value is { agentSessionId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "agentSessionId" in value &&
    typeof (value as { agentSessionId: unknown }).agentSessionId === "string"
  );
}
