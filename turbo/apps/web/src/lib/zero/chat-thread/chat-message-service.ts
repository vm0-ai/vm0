import { eq, asc, desc, and, isNotNull, isNull, sql } from "drizzle-orm";
import { chatMessages } from "../../../db/schema/chat-message";
import { chatThreads } from "../../../db/schema/chat-thread";
import { agentRuns } from "../../../db/schema/agent-run";
import { zeroRuns } from "../../../db/schema/zero-run";

/**
 * Insert a chat message. chat_messages is an append-only table — rows are
 * never updated or deleted after creation.
 */
export async function insertChatMessage(params: {
  chatThreadId: string;
  role: "user" | "assistant";
  content: string | null;
  runId: string | null;
  error?: string | null;
}): Promise<{ id: string; createdAt: Date }> {
  const [row] = await globalThis.services.db
    .insert(chatMessages)
    .values({
      chatThreadId: params.chatThreadId,
      role: params.role,
      content: params.content,
      runId: params.runId,
      error: params.error ?? null,
    })
    .returning({ id: chatMessages.id, createdAt: chatMessages.createdAt });

  if (!row) {
    throw new Error("Failed to insert chat message");
  }
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

  return rows.length;
}

/**
 * Resolve the chat_thread_id and owner userId for a run from the zero_runs
 * table. Returns null when the run is not tied to a chat thread (e.g.,
 * non-chat triggers like cron/schedule), so event consumers can silently skip.
 */
export async function getChatThreadIdForRun(
  runId: string,
): Promise<{ chatThreadId: string; userId: string } | null> {
  const [row] = await globalThis.services.db
    .select({
      chatThreadId: chatThreads.id,
      userId: chatThreads.userId,
    })
    .from(zeroRuns)
    .innerJoin(chatThreads, eq(zeroRuns.chatThreadId, chatThreads.id))
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return row ?? null;
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
    })
    .from(chatMessages)
    .leftJoin(agentRuns, eq(chatMessages.runId, agentRuns.id))
    .where(eq(chatMessages.chatThreadId, chatThreadId))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.sequenceNumber));
}

/**
 * Get the latest session ID for a thread by finding the most recent
 * completed run's result.agentSessionId.
 * Used for runner session continuity (continuedFromSessionId).
 */
export async function getLatestSessionIdForThread(
  chatThreadId: string,
): Promise<string | undefined> {
  const rows = await globalThis.services.db
    .select({
      result: agentRuns.result,
    })
    .from(chatMessages)
    .innerJoin(agentRuns, eq(chatMessages.runId, agentRuns.id))
    .where(
      and(
        eq(chatMessages.chatThreadId, chatThreadId),
        eq(chatMessages.role, "assistant"),
        isNotNull(chatMessages.runId),
      ),
    )
    .orderBy(desc(chatMessages.createdAt))
    .limit(5);

  for (const row of rows) {
    if (hasAgentSessionId(row.result)) {
      return row.result.agentSessionId;
    }
  }
  return undefined;
}

/**
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

  // Build cursor condition from sinceId
  let cursorCondition;
  if (sinceId) {
    // Use a subquery to resolve the cursor row's sort position.
    // Tuple comparison (createdAt, coalesce(sequenceNumber, -1)) ensures
    // correct ordering even when multiple messages share the same timestamp.
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
