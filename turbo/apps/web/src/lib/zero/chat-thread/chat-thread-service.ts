import { eq, and, desc } from "drizzle-orm";
import { chatThreads } from "../../../db/schema/chat-thread";
import { notFound } from "../../shared/errors";
import {
  getMessagesByThreadId,
  getMessagesByThreadIdSince,
  getLatestSessionIdForThread,
} from "./chat-message-service";
import { type PersistedAttachment, persistedAttachmentSchema } from "@vm0/core";

/**
 * Create a new chat thread.
 *
 * `sourceScheduleRunId`, when set, marks this thread as continuing a
 * previously scheduled agent run. The chat messages route reads it once on the
 * thread's first run to seed a system prompt instructing the agent to pull the
 * original run's telemetry via `zero logs <id>`; subsequent runs inherit the
 * resulting session context and do not get the prompt again.
 */
export async function createChatThread(
  userId: string,
  agentComposeId: string,
  title?: string | null,
  sourceScheduleRunId?: string | null,
): Promise<{ id: string; createdAt: Date }> {
  const [thread] = await globalThis.services.db
    .insert(chatThreads)
    .values({
      userId,
      agentComposeId,
      title: title ?? null,
      sourceScheduleRunId: sourceScheduleRunId ?? null,
    })
    .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });

  if (!thread) {
    throw new Error("Failed to create chat thread");
  }

  return thread;
}

/**
 * List chat threads for a user + agent compose, ordered by updatedAt desc.
 */
export async function listChatThreads(
  userId: string,
  agentComposeId: string,
): Promise<
  Array<{
    id: string;
    title: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>
> {
  const threads = await globalThis.services.db
    .select({
      id: chatThreads.id,
      title: chatThreads.title,
      createdAt: chatThreads.createdAt,
      updatedAt: chatThreads.updatedAt,
    })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.userId, userId),
        eq(chatThreads.agentComposeId, agentComposeId),
      ),
    )
    .orderBy(desc(chatThreads.updatedAt));

  return threads;
}

/**
 * Get a chat thread by ID with ownership check.
 */
export async function getChatThread(
  threadId: string,
  userId: string,
): Promise<{
  id: string;
  title: string | null;
  agentComposeId: string;
  sourceScheduleRunId: string | null;
  draftContent: string | null;
  draftAttachments: PersistedAttachment[] | null;
  createdAt: Date;
  updatedAt: Date;
}> {
  const [thread] = await globalThis.services.db
    .select()
    .from(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .limit(1);

  if (!thread) {
    throw notFound("Chat thread not found");
  }

  return {
    id: thread.id,
    title: thread.title,
    agentComposeId: thread.agentComposeId,
    sourceScheduleRunId: thread.sourceScheduleRunId ?? null,
    draftContent: thread.draftContent ?? null,
    draftAttachments: persistedAttachmentSchema
      .array()
      .nullable()
      .parse(thread.draftAttachments ?? null),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

/**
 * Update a chat thread's draft content and attachments.
 * Ownership check in WHERE clause ensures users can only update their own threads.
 */
export async function updateChatThreadDraft(
  threadId: string,
  userId: string,
  draftContent: string | null,
  draftAttachments: PersistedAttachment[] | null,
): Promise<void> {
  const updated = await globalThis.services.db
    .update(chatThreads)
    .set({ draftContent, draftAttachments })
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .returning({ id: chatThreads.id });

  if (updated.length === 0) {
    throw notFound("Chat thread not found");
  }
}

/**
 * Delete a chat thread with ownership check.
 * Cascade deletes handle chat_messages cleanup.
 */
export async function deleteChatThread(
  threadId: string,
  userId: string,
): Promise<void> {
  const deleted = await globalThis.services.db
    .delete(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .returning({ id: chatThreads.id });

  if (deleted.length === 0) {
    throw notFound("Chat thread not found");
  }
}

/**
 * Update a chat thread's title.
 */
export async function updateChatThreadTitle(
  threadId: string,
  title: string,
): Promise<void> {
  await globalThis.services.db
    .update(chatThreads)
    .set({ title })
    .where(eq(chatThreads.id, threadId));
}

type ChatMessage = {
  role: "user" | "assistant";
  content: string | null;
  runId?: string;
  error?: string;
  status?: string;
  createdAt: string;
};

/**
 * Get messages for a chat thread from the chat_messages table.
 * Returns all rows as flat chatMessages with optional run status.
 * The frontend uses the status field to detect active runs and start polling.
 */
export async function getChatThreadMessages(threadId: string): Promise<{
  chatMessages: ChatMessage[];
  latestSessionId: string | null;
}> {
  const [rows, latestSessionId] = await Promise.all([
    getMessagesByThreadId(threadId),
    getLatestSessionIdForThread(threadId),
  ]);

  const chatMessages: ChatMessage[] = rows.map((row) => {
    // Event-backed rows (sequence_number set) carry their own valid assistant
    // text — they must never inherit the run-level error via the leftJoin,
    // or a timed-out run would mask every intermediate message as "failed".
    // The placeholder row (sequence_number IS NULL) is the only row that
    // falls back to agent_runs.error, covering the case where the terminal
    // callback failed to deliver and chat_messages.error was never written.
    const isPlaceholder = row.sequenceNumber === null;
    const effectiveError = isPlaceholder
      ? (row.error ?? row.runError ?? undefined)
      : (row.error ?? undefined);
    return {
      role: row.role as "user" | "assistant",
      content: row.content,
      runId: row.runId ?? undefined,
      error: effectiveError,
      status: row.runStatus ?? undefined,
      createdAt: row.createdAt.toISOString(),
    };
  });

  return {
    chatMessages,
    latestSessionId: latestSessionId ?? null,
  };
}

type ChatMessageWithId = {
  id: string;
  role: "user" | "assistant";
  content: string | null;
  runId?: string;
  error?: string;
  status?: string;
  sequenceNumber?: number | null;
  createdAt: string;
};

/**
 * Get messages for a chat thread after the given sinceId cursor.
 * When sinceId is omitted all thread messages are returned.
 * Applies the same placeholder-vs-event-backed error logic as getChatThreadMessages.
 */
export async function getChatThreadMessagesSince(
  threadId: string,
  sinceId?: string,
): Promise<ChatMessageWithId[]> {
  const rows = await getMessagesByThreadIdSince(threadId, sinceId);

  return rows.map((row) => {
    const isPlaceholder = row.sequenceNumber === null;
    const effectiveError = isPlaceholder
      ? (row.error ?? row.runError ?? undefined)
      : (row.error ?? undefined);
    return {
      id: row.id,
      role: row.role as "user" | "assistant",
      content: row.content,
      runId: row.runId ?? undefined,
      error: effectiveError,
      status: row.runStatus ?? undefined,
      sequenceNumber: row.sequenceNumber,
      createdAt: row.createdAt.toISOString(),
    };
  });
}
