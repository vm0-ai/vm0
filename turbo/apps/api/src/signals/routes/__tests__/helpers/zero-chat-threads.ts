import { randomUUID } from "node:crypto";

import type { PersistedAttachment } from "@vm0/api-contracts/contracts/chat-threads";
import { command } from "ccstate";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { eq, inArray } from "drizzle-orm";

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

    // Find run ids tied to this fixture's user (created by seedRun$ from
    // helpers/zero-usage-insight.ts). Some tests don't seed runs at all, so
    // this may be empty.
    const runRows = await writeDb
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.userId, fixture.userId));
    signal.throwIfAborted();
    const runIds = runRows.map((row) => {
      return row.id;
    });

    // chat_messages first (FKs into chat_threads + agent_runs).
    await writeDb
      .delete(chatMessages)
      .where(eq(chatMessages.chatThreadId, fixture.threadId));
    signal.throwIfAborted();

    if (runIds.length > 0) {
      await writeDb.delete(zeroRuns).where(inArray(zeroRuns.id, runIds));
      signal.throwIfAborted();
      await writeDb.delete(agentRuns).where(inArray(agentRuns.id, runIds));
      signal.throwIfAborted();
    }

    await writeDb
      .delete(agentSessions)
      .where(eq(agentSessions.userId, fixture.userId));
    signal.throwIfAborted();
    await writeDb
      .delete(chatThreads)
      .where(eq(chatThreads.id, fixture.threadId));
    signal.throwIfAborted();
    await writeDb
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.composeId, fixture.composeId));
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
