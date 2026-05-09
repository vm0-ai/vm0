import { randomUUID } from "node:crypto";

import type { PersistedAttachment } from "@vm0/api-contracts/contracts/chat-threads";
import { command } from "ccstate";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";
import { nowDate } from "../../../external/time";

export interface ZeroChatThreadFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly composeId: string;
  readonly threadId: string;
}

interface SeedChatThreadOptions {
  readonly userId?: string;
  readonly orgId?: string;
  readonly title?: string | null;
  readonly pinnedAt?: Date | null;
  readonly renamedAt?: Date | null;
  readonly lastReadMessageId?: string | null;
  readonly draftContent?: string | null;
  readonly draftAttachments?: readonly PersistedAttachment[] | null;
  readonly createdAt?: Date;
  readonly agentAvatarUrl?: string | null;
}

export const seedZeroChatThread$ = command(
  async (
    { set },
    options: SeedChatThreadOptions,
    signal: AbortSignal,
  ): Promise<ZeroChatThreadFixture> => {
    const userId = options.userId ?? `user_${randomUUID()}`;
    const orgId = options.orgId ?? `org_${randomUUID()}`;
    const composeId = randomUUID();
    const threadId = randomUUID();
    const writeDb = set(writeDb$);

    await writeDb.insert(agentComposes).values({
      id: composeId,
      userId,
      orgId,
      name: `compose-${composeId.slice(0, 8)}`,
    });
    signal.throwIfAborted();
    await writeDb.insert(zeroAgents).values({
      id: composeId,
      orgId,
      owner: userId,
      name: `agent-${composeId.slice(0, 8)}`,
      ...(options.agentAvatarUrl !== undefined
        ? { avatarUrl: options.agentAvatarUrl }
        : {}),
    });
    signal.throwIfAborted();
    await writeDb.insert(chatThreads).values({
      id: threadId,
      userId,
      agentComposeId: composeId,
      title: options.title ?? "chat thread",
      pinnedAt: options.pinnedAt ?? null,
      renamedAt: options.renamedAt ?? null,
      ...(options.lastReadMessageId !== undefined
        ? { lastReadMessageId: options.lastReadMessageId }
        : {}),
      ...(options.draftContent !== undefined
        ? { draftContent: options.draftContent }
        : {}),
      ...(options.draftAttachments !== undefined
        ? {
            draftAttachments: options.draftAttachments
              ? [...options.draftAttachments]
              : null,
          }
        : {}),
      ...(options.createdAt !== undefined
        ? { createdAt: options.createdAt }
        : {}),
    });
    signal.throwIfAborted();

    return { userId, orgId, composeId, threadId };
  },
);

export const deleteZeroChatThread$ = command(
  async (
    { set },
    fixture: ZeroChatThreadFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .delete(chatThreads)
      .where(eq(chatThreads.id, fixture.threadId));
    signal.throwIfAborted();
    await writeDb
      .delete(zeroAgents)
      .where(eq(zeroAgents.id, fixture.composeId));
    signal.throwIfAborted();
    await writeDb
      .delete(agentComposes)
      .where(eq(agentComposes.id, fixture.composeId));
    signal.throwIfAborted();
  },
);

interface SeedChatMessageOptions {
  readonly role: "user" | "assistant";
  readonly content: string | null;
  readonly attachFiles?: readonly string[];
  readonly createdAt?: Date;
  readonly sequenceNumber?: number | null;
  readonly archivedAt?: Date | null;
}

export const seedZeroChatMessage$ = command(
  async (
    { set },
    fixture: ZeroChatThreadFixture,
    options: SeedChatMessageOptions,
    signal: AbortSignal,
  ): Promise<string> => {
    const id = randomUUID();
    const writeDb = set(writeDb$);
    await writeDb.insert(chatMessages).values({
      id,
      chatThreadId: fixture.threadId,
      role: options.role,
      content: options.content,
      attachFiles: options.attachFiles ? [...options.attachFiles] : null,
      sequenceNumber: options.sequenceNumber ?? null,
      createdAt: options.createdAt ?? nowDate(),
      ...(options.archivedAt !== undefined
        ? { archivedAt: options.archivedAt }
        : {}),
    });
    signal.throwIfAborted();
    return id;
  },
);
