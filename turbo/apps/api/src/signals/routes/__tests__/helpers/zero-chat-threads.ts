import { randomUUID } from "node:crypto";

import type { PersistedAttachment } from "@vm0/api-contracts/contracts/chat-threads";
import { command } from "ccstate";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import {
  chatMessages,
  type ChatMessageAttachFileMetadata,
} from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq, inArray, sql } from "drizzle-orm";

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

interface SeedChatMessageOptions {
  readonly role: "user" | "assistant";
  readonly content: string | null;
  readonly attachFiles?: readonly string[];
  readonly attachFileMetadata?: readonly ChatMessageAttachFileMetadata[];
  readonly createdAt?: Date;
  readonly sequenceNumber?: number | null;
  readonly runId?: string | null;
}

export const seedZeroChatMessage$ = command(
  async (
    { set },
    fixture: ZeroChatThreadFixture,
    options: SeedChatMessageOptions,
    signal: AbortSignal,
  ): Promise<string> => {
    const id = randomUUID();
    const createdAt = options.createdAt ?? nowDate();
    const writeDb = set(writeDb$);
    await writeDb.insert(chatMessages).values({
      id,
      chatThreadId: fixture.threadId,
      role: options.role,
      content: options.content,
      attachFiles: options.attachFiles ? [...options.attachFiles] : null,
      attachFileMetadata: options.attachFileMetadata
        ? [...options.attachFileMetadata]
        : null,
      sequenceNumber: options.sequenceNumber ?? null,
      runId: options.runId ?? null,
      createdAt,
    });
    signal.throwIfAborted();
    // Resync the denormalized recency column with the seeded message set so
    // backdated test fixtures order deterministically instead of all bunching
    // at the thread's defaultNow() lastMessageAt.
    await writeDb
      .update(chatThreads)
      .set({
        lastMessageAt: sql`COALESCE(
          (SELECT MAX(${chatMessages.createdAt})
             FROM ${chatMessages}
            WHERE ${chatMessages.chatThreadId} = ${chatThreads.id}),
          ${chatThreads.lastMessageAt}
        )`,
      })
      .where(eq(chatThreads.id, fixture.threadId));
    signal.throwIfAborted();
    return id;
  },
);

// Mirrors web's addTestRunToThread: links a previously-seeded run to a thread
// by inserting the user-side chat_message row and stamping zero_runs.chatThreadId.
export const addRunToThread$ = command(
  async (
    { set },
    args: {
      readonly threadId: string;
      readonly runId: string;
      readonly prompt?: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb.insert(chatMessages).values({
      chatThreadId: args.threadId,
      role: "user",
      content: args.prompt ?? "test prompt",
      runId: args.runId,
    });
    signal.throwIfAborted();
    await writeDb
      .update(zeroRuns)
      .set({ chatThreadId: args.threadId })
      .where(eq(zeroRuns.id, args.runId));
    signal.throwIfAborted();
  },
);

// Mirrors web's insertTestAssistantEventMessages: bulk-insert assistant
// chat_message rows backed by realtime events (runId + sequenceNumber). The
// regression these guard (PR #12372) is that a later run-level error must NOT
// mask the per-row content during the leftJoin in the read path.
export const seedAssistantEventMessages$ = command(
  async (
    { set },
    args: {
      readonly threadId: string;
      readonly runId: string;
      readonly items: readonly {
        readonly sequenceNumber: number;
        readonly content: string;
      }[];
    },
    signal: AbortSignal,
  ): Promise<void> => {
    if (args.items.length === 0) {
      return;
    }
    const writeDb = set(writeDb$);
    await writeDb
      .insert(chatMessages)
      .values(
        args.items.map((item) => {
          return {
            chatThreadId: args.threadId,
            runId: args.runId,
            role: "assistant" as const,
            content: item.content,
            sequenceNumber: item.sequenceNumber,
          };
        }),
      )
      .onConflictDoNothing({
        target: [chatMessages.runId, chatMessages.sequenceNumber],
      });
    signal.throwIfAborted();
  },
);

// Mirrors web's updateTestChatThreadTitle (used by the AI title-generation
// webhook). Tests that exercise post-completion title rewrite call this.
export const updateChatThreadTitle$ = command(
  async (
    { set },
    args: {
      readonly threadId: string;
      readonly userId: string;
      readonly title: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .update(chatThreads)
      .set({ title: args.title, renamedAt: nowDate() })
      .where(
        and(
          eq(chatThreads.id, args.threadId),
          eq(chatThreads.userId, args.userId),
        ),
      );
    signal.throwIfAborted();
  },
);

// Mirrors web's transitionRunStatus: stamps a run with a new status +
// completedAt + error. Used for the timeout-doesn't-mask-event-content test
// (the regression #12372 fixed).
export const transitionRunStatus$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly status: string;
      readonly completedAt?: Date | null;
      readonly error?: string | null;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .update(agentRuns)
      .set({
        status: args.status,
        completedAt: args.completedAt ?? null,
        error: args.error ?? null,
      })
      .where(eq(agentRuns.id, args.runId));
    signal.throwIfAborted();
  },
);
