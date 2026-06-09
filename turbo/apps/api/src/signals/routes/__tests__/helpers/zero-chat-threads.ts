import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import { writeDb$ } from "../../../external/db";

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
      ...(options.createdAt !== undefined
        ? { createdAt: options.createdAt }
        : {}),
    });
    signal.throwIfAborted();

    return { userId, orgId, composeId, threadId };
  },
);
