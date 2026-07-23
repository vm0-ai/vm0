import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { eq, isNotNull, sql } from "drizzle-orm";

import type { Db } from "../external/db";

type ChatMessageInsert = typeof chatMessages.$inferInsert;
type ChatMessageWriteDb = Pick<Db, "insert" | "update">;

export type NewChatMessage = Omit<
  ChatMessageInsert,
  "revokesMessageId" | "seqId"
>;

interface ChatMessageCommandResult {
  readonly id: string;
  readonly createdAt: Date;
  readonly seqId: number;
}

interface ChatMessageBatchCommandResult {
  readonly id: string;
  readonly createdAt: Date;
  readonly seqId: number;
  readonly sequenceNumber: number | null;
}

type InsertChatMessageConflict = "none" | "any" | "id" | "run-lifecycle";

type InsertChatMessagesConflict = "any" | "run-sequence";

interface DeleteChatMessageInput {
  readonly id?: string;
  readonly chatThreadId: string;
  readonly role: ChatMessageInsert["role"];
  readonly runId?: string | null;
  readonly runGroupId?: string | null;
  readonly runEventId?: string | null;
  readonly sequenceNumber?: number | null;
  readonly createdAt?: Date;
}

async function reserveChatMessageSeqIds(
  tx: ChatMessageWriteDb,
  chatThreadId: string,
  count: number,
): Promise<number> {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("chat message seq_id reservation count must be positive");
  }

  const [thread] = await tx
    .update(chatThreads)
    .set({
      lastChatMessageSeqId: sql`${chatThreads.lastChatMessageSeqId} + ${count}`,
    })
    .where(eq(chatThreads.id, chatThreadId))
    .returning({ lastSeqId: chatThreads.lastChatMessageSeqId });
  if (!thread) {
    throw new Error(`Chat thread ${chatThreadId} not found`);
  }
  return thread.lastSeqId - count + 1;
}

async function addSeqIdsToMessages(
  tx: ChatMessageWriteDb,
  values: readonly NewChatMessage[],
): Promise<readonly (NewChatMessage & { readonly seqId: number })[]> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value.chatThreadId, (counts.get(value.chatThreadId) ?? 0) + 1);
  }

  const nextSeqIdByThread = new Map<string, number>();
  for (const [chatThreadId, count] of [...counts].sort(([left], [right]) => {
    return left.localeCompare(right);
  })) {
    nextSeqIdByThread.set(
      chatThreadId,
      await reserveChatMessageSeqIds(tx, chatThreadId, count),
    );
  }

  return values.map((value) => {
    const seqId = nextSeqIdByThread.get(value.chatThreadId);
    if (seqId === undefined) {
      throw new Error(`Chat thread ${value.chatThreadId} was not reserved`);
    }
    nextSeqIdByThread.set(value.chatThreadId, seqId + 1);
    return { ...value, seqId };
  });
}

/** Insert an immutable chat message using the caller-owned transaction. */
export async function insertChatMessage(
  tx: ChatMessageWriteDb,
  values: NewChatMessage,
  conflict: InsertChatMessageConflict = "none",
): Promise<ChatMessageCommandResult | null> {
  const valuesWithSeqIds = await addSeqIdsToMessages(tx, [values]);
  const valueWithSeqId = valuesWithSeqIds[0];
  if (!valueWithSeqId) {
    throw new Error("chat message seq_id was not assigned");
  }

  const query = tx.insert(chatMessages).values(valueWithSeqId);
  const rows =
    conflict === "any"
      ? await query.onConflictDoNothing().returning({
          id: chatMessages.id,
          createdAt: chatMessages.createdAt,
          seqId: chatMessages.seqId,
        })
      : conflict === "id"
        ? await query
            .onConflictDoNothing({ target: chatMessages.id })
            .returning({
              id: chatMessages.id,
              createdAt: chatMessages.createdAt,
              seqId: chatMessages.seqId,
            })
        : conflict === "run-lifecycle"
          ? await query
              .onConflictDoNothing({
                target: chatMessages.runId,
                where: isNotNull(chatMessages.runLifecycleEvent),
              })
              .returning({
                id: chatMessages.id,
                createdAt: chatMessages.createdAt,
                seqId: chatMessages.seqId,
              })
          : await query.returning({
              id: chatMessages.id,
              createdAt: chatMessages.createdAt,
              seqId: chatMessages.seqId,
            });

  return rows[0] ?? null;
}

export async function insertChatMessages(
  tx: ChatMessageWriteDb,
  values: readonly NewChatMessage[],
  conflict: InsertChatMessagesConflict,
): Promise<readonly ChatMessageBatchCommandResult[]> {
  if (values.length === 0) {
    return [];
  }

  const valuesWithSeqIds = await addSeqIdsToMessages(tx, values);
  const query = tx.insert(chatMessages).values([...valuesWithSeqIds]);
  if (conflict === "any") {
    return await query.onConflictDoNothing().returning({
      id: chatMessages.id,
      createdAt: chatMessages.createdAt,
      seqId: chatMessages.seqId,
      sequenceNumber: chatMessages.sequenceNumber,
    });
  }
  return await query
    .onConflictDoNothing({
      target: [chatMessages.runId, chatMessages.sequenceNumber],
    })
    .returning({
      id: chatMessages.id,
      createdAt: chatMessages.createdAt,
      seqId: chatMessages.seqId,
      sequenceNumber: chatMessages.sequenceNumber,
    });
}

/** Append and return a replacement row for an existing chat message. */
export async function updateChatMessage(
  tx: ChatMessageWriteDb,
  messageId: string,
  replacement: NewChatMessage,
): Promise<ChatMessageCommandResult | null> {
  const seqId = await reserveChatMessageSeqIds(tx, replacement.chatThreadId, 1);
  const rows = await tx
    .insert(chatMessages)
    .values({ ...replacement, seqId, revokesMessageId: messageId })
    .onConflictDoNothing()
    .returning({
      id: chatMessages.id,
      createdAt: chatMessages.createdAt,
      seqId: chatMessages.seqId,
    });
  return rows[0] ?? null;
}

/** Append and return a contentless tombstone for an existing chat message. */
export async function deleteChatMessage(
  tx: ChatMessageWriteDb,
  messageId: string,
  tombstone: DeleteChatMessageInput,
): Promise<ChatMessageCommandResult | null> {
  return await updateChatMessage(tx, messageId, {
    ...tombstone,
    content: null,
  });
}
