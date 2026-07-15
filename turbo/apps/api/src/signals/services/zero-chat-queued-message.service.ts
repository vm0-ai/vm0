import type { ModelProviderCredentialScope } from "@vm0/api-contracts/contracts/model-providers";
import { chatMessageQueue } from "@vm0/db/schema/chat-message-queue";
import {
  chatMessages,
  type ChatMessageAttachFileMetadata,
  type ChatMessageGenerationTemplate,
} from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";

import type { Db } from "../external/db";

export interface QueuedUserMessage {
  readonly id: string;
  readonly content: string | null;
  readonly attachFiles: readonly string[] | null;
  readonly attachFileMetadata: readonly ChatMessageAttachFileMetadata[] | null;
  readonly generationTemplate: ChatMessageGenerationTemplate | null;
  readonly modelProviderId: string | null;
  readonly modelProviderType: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly selectedModel: string | null;
}

function unclaimedQueuedUserMessageCondition(
  threadId: string,
): SQL | undefined {
  return and(
    eq(chatMessages.chatThreadId, threadId),
    eq(chatMessages.role, "user"),
    isNull(chatMessages.runId),
    isNull(chatMessages.error),
    isNull(chatMessages.revokesMessageId),
    isNull(chatMessages.interruptsRunId),
    sql`NOT EXISTS (
      SELECT 1
      FROM ${chatMessages} AS revoker
      WHERE revoker.revokes_message_id = ${chatMessages.id}
    )`,
  );
}

export async function loadNextUnclaimedQueuedUserMessage(
  db: Db,
  threadId: string,
): Promise<QueuedUserMessage | null> {
  const [message] = await db
    .select({
      id: chatMessages.id,
      content: chatMessages.content,
      attachFiles: chatMessages.attachFiles,
      attachFileMetadata: chatMessages.attachFileMetadata,
      generationTemplate: chatMessages.generationTemplate,
      modelProviderId: sql<null>`NULL`,
      modelProviderType: sql<null>`NULL`,
      modelProviderCredentialScope: sql<null>`NULL`,
      selectedModel: chatThreads.selectedModel,
    })
    .from(chatMessages)
    .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.chatThreadId))
    .where(unclaimedQueuedUserMessageCondition(threadId))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
    .limit(1);

  return message ?? null;
}

export async function hasUnclaimedQueuedUserMessage(
  db: Db,
  threadId: string,
): Promise<boolean> {
  const [message] = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(unclaimedQueuedUserMessageCondition(threadId))
    .limit(1);

  return message !== undefined;
}

/** Persist the queue pointer used by the shared per-thread scheduler. */
export async function enqueueUserMessageQueueItem(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly chatThreadId: string;
    readonly chatMessageId: string;
  },
): Promise<void> {
  await db
    .insert(chatMessageQueue)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      chatThreadId: args.chatThreadId,
      itemType: "user_message",
      chatMessageId: args.chatMessageId,
    })
    .onConflictDoNothing();
}

export async function deleteUserMessageQueueItem(
  db: Db,
  chatMessageId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(chatMessageQueue)
    .where(
      and(
        eq(chatMessageQueue.itemType, "user_message"),
        eq(chatMessageQueue.chatMessageId, chatMessageId),
      ),
    )
    .returning({ id: chatMessageQueue.id });
  return deleted.length > 0;
}

export async function hasUserMessageQueueItem(
  db: Db,
  chatMessageId: string,
): Promise<boolean> {
  const [item] = await db
    .select({ id: chatMessageQueue.id })
    .from(chatMessageQueue)
    .where(
      and(
        eq(chatMessageQueue.itemType, "user_message"),
        eq(chatMessageQueue.chatMessageId, chatMessageId),
      ),
    )
    .limit(1);
  return item !== undefined;
}

/**
 * Claim a queue-first user message for a created run: bind the run id onto
 * the existing message row and consume its queue item. Serialized on the
 * thread row like the legacy claim. Returns the claimed message's createdAt,
 * or null when the message was already claimed or recalled.
 */
export async function claimUserMessageInPlace(
  db: Db,
  args: {
    readonly threadId: string;
    readonly messageId: string;
    readonly runId: string;
  },
): Promise<{ readonly createdAt: Date } | null> {
  return await db.transaction(async (tx) => {
    const threadRows = await tx.execute<{ readonly id: string }>(sql`
      SELECT ${chatThreads.id} AS "id"
      FROM ${chatThreads}
      WHERE ${chatThreads.id} = ${args.threadId}
      FOR UPDATE
    `);
    if (!threadRows.rows[0]) {
      return null;
    }

    const [claimed] = await tx
      .update(chatMessages)
      .set({ runId: args.runId })
      .where(
        and(
          eq(chatMessages.id, args.messageId),
          eq(chatMessages.chatThreadId, args.threadId),
          eq(chatMessages.role, "user"),
          isNull(chatMessages.runId),
        ),
      )
      .returning({ createdAt: chatMessages.createdAt });
    if (!claimed) {
      return null;
    }
    await deleteUserMessageQueueItem(tx, args.messageId);
    return claimed;
  });
}

/**
 * Discard a queue-first user message that never dispatched (run creation
 * failed): remove both the queue item and the unclaimed message row so the
 * thread history matches the legacy direct-send failure behavior.
 */
export async function discardUnclaimedUserMessage(
  db: Db,
  args: {
    readonly threadId: string;
    readonly messageId: string;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await deleteUserMessageQueueItem(tx, args.messageId);
    await tx
      .delete(chatMessages)
      .where(
        and(
          eq(chatMessages.id, args.messageId),
          eq(chatMessages.chatThreadId, args.threadId),
          eq(chatMessages.role, "user"),
          isNull(chatMessages.runId),
        ),
      );
  });
}
