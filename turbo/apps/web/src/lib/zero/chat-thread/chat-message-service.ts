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
 * Fetch chat messages for a thread, rendered in natural chronological order
 * (createdAt ASC, sequenceNumber ASC).
 *
 * - When `sinceId` is provided: returns up to `limit` messages strictly after
 *   the cursor, forward-paginating through the thread.
 * - When `sinceId` is omitted: returns the *latest* `limit` messages,
 *   re-sorted ASC for rendering. This anchors the initial view at the most
 *   recent activity rather than the thread's beginning.
 */
export async function getMessagesSince(
  chatThreadId: string,
  sinceId: string | undefined,
  limit: number,
): Promise<
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
  }>
> {
  const db = globalThis.services.db;

  const columns = {
    id: chatMessages.id,
    role: chatMessages.role,
    content: chatMessages.content,
    runId: chatMessages.runId,
    error: chatMessages.error,
    sequenceNumber: chatMessages.sequenceNumber,
    createdAt: chatMessages.createdAt,
    runStatus: agentRuns.status,
    runError: agentRuns.error,
  };

  if (sinceId === undefined) {
    const rows = await db
      .select(columns)
      .from(chatMessages)
      .leftJoin(agentRuns, eq(chatMessages.runId, agentRuns.id))
      .where(eq(chatMessages.chatThreadId, chatThreadId))
      .orderBy(desc(chatMessages.createdAt), desc(chatMessages.sequenceNumber))
      .limit(limit);
    return rows.reverse();
  }

  const cursorCondition = sql`(
    ${chatMessages.createdAt},
    COALESCE(${chatMessages.sequenceNumber}, -1)
  ) > (
    SELECT ${chatMessages.createdAt}, COALESCE(${chatMessages.sequenceNumber}, -1)
    FROM ${chatMessages}
    WHERE ${chatMessages.id} = ${sinceId}
  )`;

  return db
    .select(columns)
    .from(chatMessages)
    .leftJoin(agentRuns, eq(chatMessages.runId, agentRuns.id))
    .where(and(eq(chatMessages.chatThreadId, chatThreadId), cursorCondition))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.sequenceNumber))
    .limit(limit);
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
 * Provider type of the most recent run in a thread, or null when the thread
 * has no runs yet. The composer uses this to disable picker options whose
 * base URL differs from the current session — `areProvidersCompatible`
 * operates on type, not provider id.
 */
export async function getLatestRunProviderTypeForThread(
  chatThreadId: string,
): Promise<string | null> {
  const [row] = await globalThis.services.db
    .select({ modelProvider: zeroRuns.modelProvider })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(zeroRuns.id, agentRuns.id))
    .where(eq(zeroRuns.chatThreadId, chatThreadId))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return row?.modelProvider ?? null;
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
      runResult: agentRuns.result,
    })
    .from(chatMessages)
    .leftJoin(agentRuns, eq(chatMessages.runId, agentRuns.id))
    .where(eq(chatMessages.chatThreadId, chatThreadId))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.sequenceNumber));

  let anchorIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    if (hasAgentSessionId(rows[i]!.runResult)) {
      anchorIndex = i;
    }
  }

  const candidates: IncompleteRoundRow[] = [];
  for (let i = anchorIndex + 1; i < rows.length; i++) {
    const row = rows[i]!;
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
