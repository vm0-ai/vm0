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
import {
  deleteChatMessage,
  updateChatMessage,
} from "./zero-chat-message.service";

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
    eq(chatMessageQueue.chatThreadId, threadId),
    eq(chatMessageQueue.itemType, "user_message"),
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
    .from(chatMessageQueue)
    .innerJoin(
      chatMessages,
      eq(chatMessages.id, chatMessageQueue.chatMessageId),
    )
    .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.chatThreadId))
    .where(unclaimedQueuedUserMessageCondition(threadId))
    .orderBy(asc(chatMessageQueue.createdAt), asc(chatMessageQueue.id))
    .limit(1);

  return message ?? null;
}

export async function hasUnclaimedQueuedUserMessage(
  db: Db,
  threadId: string,
): Promise<boolean> {
  const [item] = await db
    .select({ id: chatMessageQueue.id })
    .from(chatMessageQueue)
    .where(unclaimedQueuedUserMessageCondition(threadId))
    .limit(1);

  return item !== undefined;
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
  args: {
    readonly threadId: string;
    readonly messageId: string;
  },
): Promise<boolean> {
  const deleted = await db
    .delete(chatMessageQueue)
    .where(
      and(
        eq(chatMessageQueue.itemType, "user_message"),
        eq(chatMessageQueue.chatThreadId, args.threadId),
        eq(chatMessageQueue.chatMessageId, args.messageId),
      ),
    )
    .returning({ id: chatMessageQueue.id });
  return deleted.length > 0;
}

interface ClaimedUserMessage {
  readonly createdAt: Date;
}

/**
 * Append the run-associated replacement for a queued user message and consume
 * its queue item. Callers serialize dispatch decisions before invoking this.
 */
export async function appendClaimedUserMessage(
  db: Db,
  args: {
    readonly threadId: string;
    readonly messageId: string;
    readonly runId: string;
  },
): Promise<ClaimedUserMessage | null> {
  const [queued] = await db
    .select({
      content: chatMessages.content,
      attachFiles: chatMessages.attachFiles,
      attachFileMetadata: chatMessages.attachFileMetadata,
      generationTemplate: chatMessages.generationTemplate,
    })
    .from(chatMessageQueue)
    .innerJoin(
      chatMessages,
      eq(chatMessages.id, chatMessageQueue.chatMessageId),
    )
    .where(
      and(
        eq(chatMessageQueue.itemType, "user_message"),
        eq(chatMessageQueue.chatMessageId, args.messageId),
        eq(chatMessageQueue.chatThreadId, args.threadId),
        eq(chatMessages.chatThreadId, args.threadId),
        eq(chatMessages.role, "user"),
        isNull(chatMessages.runId),
      ),
    )
    .for("update")
    .limit(1);
  if (!queued) {
    return null;
  }

  const claimed = await updateChatMessage(db, args.messageId, {
    chatThreadId: args.threadId,
    role: "user",
    content: queued.content,
    runId: args.runId,
    attachFiles: queued.attachFiles ? [...queued.attachFiles] : null,
    attachFileMetadata: queued.attachFileMetadata
      ? [...queued.attachFileMetadata]
      : null,
    generationTemplate: queued.generationTemplate,
  });
  if (!claimed) {
    return null;
  }
  if (
    !(await deleteUserMessageQueueItem(db, {
      threadId: args.threadId,
      messageId: args.messageId,
    }))
  ) {
    throw new Error("Claimed user message queue item disappeared");
  }
  return claimed;
}

/**
 * Serialize an inline queue claim on the thread, append its associated user
 * message, and consume the queue item.
 */
export async function claimQueuedUserMessage(
  db: Db,
  args: {
    readonly threadId: string;
    readonly messageId: string;
    readonly runId: string;
  },
): Promise<ClaimedUserMessage | null> {
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
    return await appendClaimedUserMessage(tx, args);
  });
}

/**
 * Discard a queue-first user message that never dispatched (run creation
 * failed): consume the queue item and append a tombstone so the failed send is
 * absent from the visible thread while the message stream stays append-only.
 */
export async function discardUnclaimedUserMessage(
  db: Db,
  args: {
    readonly threadId: string;
    readonly messageId: string;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const queueItemDeleted = await deleteUserMessageQueueItem(tx, {
      threadId: args.threadId,
      messageId: args.messageId,
    });
    if (!queueItemDeleted) {
      return;
    }
    const tombstone = await deleteChatMessage(tx, args.messageId, {
      chatThreadId: args.threadId,
      role: "user",
      runId: null,
    });
    if (!tombstone) {
      throw new Error("Failed to append discarded user message tombstone");
    }
  });
}
