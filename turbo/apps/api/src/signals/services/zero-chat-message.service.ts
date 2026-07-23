import { chatMessages } from "@vm0/db/schema/chat-message";
import { isNotNull } from "drizzle-orm";

import type { Db } from "../external/db";

type ChatMessageInsert = typeof chatMessages.$inferInsert;
type ChatMessageWriteDb = Pick<Db, "insert">;

export type NewChatMessage = Omit<ChatMessageInsert, "revokesMessageId">;

interface ChatMessageCommandResult {
  readonly id: string;
  readonly createdAt: Date;
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

/** Insert an immutable chat message using the caller-owned transaction. */
export async function insertChatMessage(
  tx: ChatMessageWriteDb,
  values: NewChatMessage,
  conflict: InsertChatMessageConflict = "none",
): Promise<ChatMessageCommandResult | null> {
  const query = tx.insert(chatMessages).values(values);
  const rows =
    conflict === "any"
      ? await query.onConflictDoNothing().returning({
          id: chatMessages.id,
          createdAt: chatMessages.createdAt,
        })
      : conflict === "id"
        ? await query
            .onConflictDoNothing({ target: chatMessages.id })
            .returning({
              id: chatMessages.id,
              createdAt: chatMessages.createdAt,
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
              })
          : await query.returning({
              id: chatMessages.id,
              createdAt: chatMessages.createdAt,
            });

  return rows[0] ?? null;
}

export async function insertChatMessages(
  tx: ChatMessageWriteDb,
  values: readonly NewChatMessage[],
  conflict: InsertChatMessagesConflict,
): Promise<readonly ChatMessageCommandResult[]> {
  if (values.length === 0) {
    return [];
  }

  const query = tx.insert(chatMessages).values([...values]);
  if (conflict === "any") {
    return await query.onConflictDoNothing().returning({
      id: chatMessages.id,
      createdAt: chatMessages.createdAt,
    });
  }
  return await query
    .onConflictDoNothing({
      target: [chatMessages.runId, chatMessages.sequenceNumber],
    })
    .returning({
      id: chatMessages.id,
      createdAt: chatMessages.createdAt,
    });
}

/** Append and return a replacement row for an existing chat message. */
export async function updateChatMessage(
  tx: ChatMessageWriteDb,
  messageId: string,
  replacement: NewChatMessage,
): Promise<ChatMessageCommandResult | null> {
  const rows = await tx
    .insert(chatMessages)
    .values({ ...replacement, revokesMessageId: messageId })
    .onConflictDoNothing()
    .returning({
      id: chatMessages.id,
      createdAt: chatMessages.createdAt,
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
