import type { ModelProviderCredentialScope } from "@vm0/api-contracts/contracts/model-providers";
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
