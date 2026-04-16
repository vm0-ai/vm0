import { eq, asc, desc, and, gt, isNotNull, isNull } from "drizzle-orm";
import { chatMessages } from "../../../db/schema/chat-message";
import { chatThreads } from "../../../db/schema/chat-thread";
import { agentRuns } from "../../../db/schema/agent-run";

/**
 * Insert a user message. Called immediately on send, before run dispatch.
 */
export async function insertChatMessage(params: {
  chatThreadId: string;
  role: "user" | "assistant";
  content: string | null;
  runId: string | null;
}): Promise<{ id: string; createdAt: Date }> {
  const [row] = await globalThis.services.db
    .insert(chatMessages)
    .values({
      chatThreadId: params.chatThreadId,
      role: params.role,
      content: params.content,
      runId: params.runId,
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
 * Resolve the chat_thread_id and owner user_id for a run from its placeholder
 * assistant row. Returns null when the run is not tied to a chat thread (e.g.,
 * non-chat triggers like cron/schedule), so event consumers can silently skip it.
 */
export async function getChatThreadIdForRun(
  runId: string,
): Promise<{ chatThreadId: string; userId: string } | null> {
  const [row] = await globalThis.services.db
    .select({
      chatThreadId: chatMessages.chatThreadId,
      userId: chatThreads.userId,
    })
    .from(chatMessages)
    .innerJoin(chatThreads, eq(chatMessages.chatThreadId, chatThreads.id))
    .where(
      and(eq(chatMessages.runId, runId), eq(chatMessages.role, "assistant")),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Remove the assistant placeholder for a run once event-backed rows exist.
 * If no event-backed rows arrived (e.g., tool-only run), the placeholder
 * is left in place and the UI renders an empty assistant bubble.
 */
export async function cleanupAssistantPlaceholderIfEventsExist(
  runId: string,
): Promise<void> {
  const [hasEventRow] = await globalThis.services.db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.runId, runId),
        isNotNull(chatMessages.sequenceNumber),
      ),
    )
    .limit(1);

  if (!hasEventRow) {
    return;
  }

  await globalThis.services.db
    .delete(chatMessages)
    .where(
      and(
        eq(chatMessages.runId, runId),
        eq(chatMessages.role, "assistant"),
        isNull(chatMessages.sequenceNumber),
      ),
    );
}

/**
 * Update an assistant placeholder message with content from the run callback.
 * Used for failed runs to surface the error message in the assistant bubble.
 */
export async function updateAssistantMessageByRunId(
  runId: string,
  content: string | null,
  error: string | undefined,
): Promise<void> {
  await globalThis.services.db
    .update(chatMessages)
    .set({
      content,
      error: error ?? null,
    })
    .where(
      and(
        eq(chatMessages.runId, runId),
        eq(chatMessages.role, "assistant"),
        isNull(chatMessages.sequenceNumber),
      ),
    );
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
 * Get messages for a thread after a given cursor message, ordered by
 * (created_at ASC, sequence_number ASC).
 *
 * When `sinceId` is provided, only messages whose `created_at` is strictly
 * after the cursor message's `created_at` are returned. This uses the
 * `idx_chat_messages_thread_created` btree index for efficient filtering.
 *
 * When `sinceId` is omitted all messages in the thread are returned —
 * equivalent to `getMessagesByThreadId`.
 */
export async function getMessagesByThreadIdSince(
  chatThreadId: string,
  sinceId?: string,
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
  if (!sinceId) {
    return getMessagesByThreadId(chatThreadId);
  }

  // Look up the cursor message's created_at
  const [cursor] = await globalThis.services.db
    .select({ createdAt: chatMessages.createdAt })
    .from(chatMessages)
    .where(eq(chatMessages.id, sinceId))
    .limit(1);

  if (!cursor) {
    // sinceId not found — return empty rather than throw
    return [];
  }

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
    .where(
      and(
        eq(chatMessages.chatThreadId, chatThreadId),
        gt(chatMessages.createdAt, cursor.createdAt),
      ),
    )
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
