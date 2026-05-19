import { eq, and } from "drizzle-orm";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { notFound } from "@vm0/api-services/errors";
import { publishThreadListChanged } from "./chat-message-service";
import {
  type PersistedAttachment,
  persistedAttachmentSchema,
} from "@vm0/api-contracts/contracts/chat-threads";

/**
 * Create a new chat thread.
 *
 * `pin`: when provided, stores only the selected model on the thread. Provider
 * routing is intentionally re-resolved from the current org policy for each run.
 */
export async function createChatThread(
  userId: string,
  agentComposeId: string,
  title?: string | null,
  id?: string,
  pin?: {
    modelProviderId: string | null;
    modelProviderType?: string | null;
    modelProviderCredentialScope?: string | null;
    selectedModel: string | null;
  },
): Promise<{ id: string; createdAt: Date }> {
  const [thread] = await globalThis.services.db
    .insert(chatThreads)
    .values({
      ...(id ? { id } : {}),
      userId,
      agentComposeId,
      title: title ?? null,
      modelProviderId: null,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: pin?.selectedModel ?? null,
    })
    .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });

  if (!thread) {
    throw new Error("Failed to create chat thread");
  }

  return thread;
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
  draftContent: string | null;
  draftAttachments: PersistedAttachment[] | null;
  modelProviderId: string | null;
  modelProviderType: string | null;
  modelProviderCredentialScope: string | null;
  selectedModel: string | null;
  orgId: string | null;
  lastReadMessageId: string | null;
  renamedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}> {
  const [thread] = await globalThis.services.db
    .select({
      id: chatThreads.id,
      title: chatThreads.title,
      agentComposeId: chatThreads.agentComposeId,
      draftContent: chatThreads.draftContent,
      draftAttachments: chatThreads.draftAttachments,
      selectedModel: chatThreads.selectedModel,
      orgId: zeroAgents.orgId,
      lastReadMessageId: chatThreads.lastReadMessageId,
      renamedAt: chatThreads.renamedAt,
      createdAt: chatThreads.createdAt,
      updatedAt: chatThreads.updatedAt,
    })
    .from(chatThreads)
    .leftJoin(zeroAgents, eq(zeroAgents.id, chatThreads.agentComposeId))
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .limit(1);

  if (!thread) {
    throw notFound("Chat thread not found");
  }

  return {
    id: thread.id,
    title: thread.title,
    agentComposeId: thread.agentComposeId,
    draftContent: thread.draftContent ?? null,
    draftAttachments: persistedAttachmentSchema
      .array()
      .nullable()
      .parse(thread.draftAttachments ?? null),
    modelProviderId: null,
    modelProviderType: null,
    modelProviderCredentialScope: null,
    selectedModel: thread.selectedModel ?? null,
    orgId: thread.orgId ?? null,
    lastReadMessageId: thread.lastReadMessageId ?? null,
    renamedAt: thread.renamedAt ?? null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

/**
 * Update a chat thread's title.
 */
export async function updateChatThreadTitle(
  threadId: string,
  userId: string,
  title: string,
): Promise<void> {
  const [thread] = await globalThis.services.db
    .select({ renamedAt: chatThreads.renamedAt })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);

  if (thread?.renamedAt) {
    return;
  }

  await globalThis.services.db
    .update(chatThreads)
    .set({ title })
    .where(eq(chatThreads.id, threadId));
  await publishThreadListChanged(userId);
}
