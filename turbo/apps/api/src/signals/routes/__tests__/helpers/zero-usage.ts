import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { userCache } from "@vm0/db/schema/user-cache";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { eq, inArray } from "drizzle-orm";

import { nowDate } from "../../../../lib/time";
import { writeDb$ } from "../../../external/db";

export const REALTIME_PROVIDER = "gpt-realtime-2";
export const TRANSCRIPTION_PROVIDER = "gpt-4o-mini-transcribe";

export const REALTIME_TOKEN_CATEGORIES = [
  "tokens.input.text",
  "tokens.input.audio",
  "tokens.input.cached_text",
  "tokens.input.cached_audio",
  "tokens.output.text",
  "tokens.output.audio",
] as const;

export const TRANSCRIPTION_TOKEN_CATEGORIES = [
  "tokens.input.audio",
  "tokens.input.text",
  "tokens.output.text",
] as const;

export interface UsageFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly userIds: readonly string[];
}

interface SeedUsageFixtureArgs {
  readonly currentPeriodEnd?: Date | null;
  readonly tier?: string;
}

interface InsertUsageEventArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly runId?: string | null;
  readonly kind?: string;
  readonly provider?: string;
  readonly category?: string;
  readonly quantity?: number;
  readonly creditsCharged?: number | null;
  readonly status?: string;
  readonly processedAt?: Date | null;
}

interface InsertModelUsageArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly runId?: string | null;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly creditsCharged?: number | null;
  readonly status?: string;
  readonly processedAt?: Date | null;
}

interface SeedRunArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly displayName?: string | null;
  readonly prompt?: string;
  readonly status?: string;
  readonly triggerSource?: string;
  readonly createdAt?: Date;
  readonly startedAt?: Date | null;
  readonly completedAt?: Date | null;
}

interface SeedChatThreadRunArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly title?: string | null;
  readonly triggerSource?: string;
  readonly threadId?: string;
  readonly createdAt?: Date;
}

export const seedUsageFixture$ = command(
  async (
    { set },
    args: SeedUsageFixtureArgs,
    signal: AbortSignal,
  ): Promise<UsageFixture> => {
    const db = set(writeDb$);
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    await db.insert(orgMetadata).values({
      orgId,
      tier: args.tier ?? "free",
      currentPeriodEnd: args.currentPeriodEnd ?? null,
      stripeCustomerId: args.currentPeriodEnd ? `cus_${randomUUID()}` : null,
      stripeSubscriptionId: args.currentPeriodEnd
        ? `sub_${randomUUID()}`
        : null,
      subscriptionStatus: args.currentPeriodEnd ? "active" : null,
    });
    signal.throwIfAborted();

    return { orgId, userId, userIds: [userId] };
  },
);

export const deleteUsageFixture$ = command(
  async (
    { set },
    fixture: UsageFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);

    const usageUserRows = await db
      .select({ userId: usageEvent.userId })
      .from(usageEvent)
      .where(eq(usageEvent.orgId, fixture.orgId));
    signal.throwIfAborted();

    await db.delete(usageEvent).where(eq(usageEvent.orgId, fixture.orgId));
    signal.throwIfAborted();

    const runRows = await db
      .select({ id: agentRuns.id, userId: agentRuns.userId })
      .from(agentRuns)
      .where(eq(agentRuns.orgId, fixture.orgId));
    signal.throwIfAborted();
    const runIds = runRows.map((row) => {
      return row.id;
    });
    if (runIds.length > 0) {
      await db.delete(agentRuns).where(inArray(agentRuns.id, runIds));
      signal.throwIfAborted();
    }

    await db
      .delete(agentSessions)
      .where(eq(agentSessions.orgId, fixture.orgId));
    signal.throwIfAborted();

    const composeRows = await db
      .select({ id: agentComposes.id })
      .from(agentComposes)
      .where(eq(agentComposes.orgId, fixture.orgId));
    signal.throwIfAborted();
    const composeIds = composeRows.map((row) => {
      return row.id;
    });
    if (composeIds.length > 0) {
      await db
        .delete(agentComposeVersions)
        .where(inArray(agentComposeVersions.composeId, composeIds));
      signal.throwIfAborted();
      await db.delete(zeroAgents).where(inArray(zeroAgents.id, composeIds));
      signal.throwIfAborted();
      await db
        .delete(agentComposes)
        .where(inArray(agentComposes.id, composeIds));
      signal.throwIfAborted();
    }

    const memberRows = await db
      .select({ userId: orgMembersMetadata.userId })
      .from(orgMembersMetadata)
      .where(eq(orgMembersMetadata.orgId, fixture.orgId));
    signal.throwIfAborted();

    await db
      .delete(orgMembersMetadata)
      .where(eq(orgMembersMetadata.orgId, fixture.orgId));
    signal.throwIfAborted();

    await db.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
    signal.throwIfAborted();

    const userIds = [
      ...new Set([
        ...fixture.userIds,
        ...usageUserRows.map((row) => {
          return row.userId;
        }),
        ...runRows.map((row) => {
          return row.userId;
        }),
        ...memberRows.map((row) => {
          return row.userId;
        }),
      ]),
    ];
    if (userIds.length > 0) {
      await db.delete(userCache).where(inArray(userCache.userId, userIds));
      signal.throwIfAborted();
    }
  },
);

export const insertUsageEvent$ = command(
  async (
    { set },
    args: InsertUsageEventArgs,
    signal: AbortSignal,
  ): Promise<string> => {
    const db = set(writeDb$);
    const status = args.status ?? "processed";
    const processedAt =
      args.processedAt !== undefined
        ? args.processedAt
        : status === "processed"
          ? nowDate()
          : null;
    const [row] = await db
      .insert(usageEvent)
      .values({
        runId: args.runId ?? null,
        orgId: args.orgId,
        userId: args.userId,
        kind: args.kind ?? "connector",
        provider: args.provider ?? "x",
        category: args.category ?? "tweet.read",
        quantity: args.quantity ?? 1,
        creditsCharged: args.creditsCharged ?? null,
        status,
        processedAt,
        idempotencyKey: randomUUID(),
      })
      .returning({ id: usageEvent.id });
    signal.throwIfAborted();
    if (!row) {
      throw new Error("insertUsageEvent$: insert returned no row");
    }
    return row.id;
  },
);

export const insertModelUsage$ = command(
  async (
    { set },
    args: InsertModelUsageArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const status = args.status ?? "processed";
    const processedAt =
      args.processedAt !== undefined
        ? args.processedAt
        : status === "processed"
          ? nowDate()
          : null;
    const rows: (typeof usageEvent.$inferInsert)[] = [
      {
        runId: args.runId ?? null,
        orgId: args.orgId,
        userId: args.userId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.input",
        quantity: args.inputTokens ?? 0,
        creditsCharged: args.creditsCharged ?? null,
        status,
        processedAt,
        idempotencyKey: randomUUID(),
      },
      {
        runId: args.runId ?? null,
        orgId: args.orgId,
        userId: args.userId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.output",
        quantity: args.outputTokens ?? 0,
        creditsCharged: null,
        status,
        processedAt,
        idempotencyKey: randomUUID(),
      },
      {
        runId: args.runId ?? null,
        orgId: args.orgId,
        userId: args.userId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.cache_read",
        quantity: args.cacheReadInputTokens ?? 0,
        creditsCharged: null,
        status,
        processedAt,
        idempotencyKey: randomUUID(),
      },
      {
        runId: args.runId ?? null,
        orgId: args.orgId,
        userId: args.userId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.cache_creation",
        quantity: args.cacheCreationInputTokens ?? 0,
        creditsCharged: null,
        status,
        processedAt,
        idempotencyKey: randomUUID(),
      },
    ];

    await db.insert(usageEvent).values(rows);
    signal.throwIfAborted();
  },
);

export const seedRun$ = command(
  async (
    { set },
    args: SeedRunArgs,
    signal: AbortSignal,
  ): Promise<{ runId: string; composeId: string }> => {
    const db = set(writeDb$);
    const composeName = `usage-${randomUUID().slice(0, 8)}`;
    const [compose] = await db
      .insert(agentComposes)
      .values({
        userId: args.userId,
        orgId: args.orgId,
        name: composeName,
        createdAt: args.createdAt,
      })
      .returning({ id: agentComposes.id });
    signal.throwIfAborted();
    if (!compose) {
      throw new Error("seedRun$: compose insert returned no row");
    }

    await db.insert(zeroAgents).values({
      id: compose.id,
      orgId: args.orgId,
      owner: args.userId,
      name: composeName,
      displayName: args.displayName ?? null,
    });
    signal.throwIfAborted();

    const versionId = randomUUID();
    await db.insert(agentComposeVersions).values({
      id: versionId,
      composeId: compose.id,
      content: {
        version: "1.0",
        agents: { "test-agent": { framework: "claude-code" } },
      },
      createdBy: args.userId,
    });
    signal.throwIfAborted();

    await db
      .update(agentComposes)
      .set({ headVersionId: versionId })
      .where(eq(agentComposes.id, compose.id));
    signal.throwIfAborted();

    const [session] = await db
      .insert(agentSessions)
      .values({
        userId: args.userId,
        orgId: args.orgId,
        agentComposeId: compose.id,
      })
      .returning({ id: agentSessions.id });
    signal.throwIfAborted();
    if (!session) {
      throw new Error("seedRun$: session insert returned no row");
    }

    const [run] = await db
      .insert(agentRuns)
      .values({
        userId: args.userId,
        orgId: args.orgId,
        agentComposeVersionId: versionId,
        prompt: args.prompt ?? "test prompt",
        status: args.status ?? "completed",
        sessionId: session.id,
        createdAt: args.createdAt,
        startedAt: args.startedAt,
        completedAt: args.completedAt,
      })
      .returning({ id: agentRuns.id });
    signal.throwIfAborted();
    if (!run) {
      throw new Error("seedRun$: run insert returned no row");
    }

    await db.insert(zeroRuns).values({
      id: run.id,
      triggerSource: args.triggerSource ?? "cli",
    });
    signal.throwIfAborted();

    return { runId: run.id, composeId: compose.id };
  },
);

// Seed a run that belongs to a chat thread, so it surfaces in the per-chat
// usage record. Returns the thread id alongside the run/compose ids.
export const seedChatThreadRun$ = command(
  async (
    { set },
    args: SeedChatThreadRunArgs,
    signal: AbortSignal,
  ): Promise<{ runId: string; threadId: string; composeId: string }> => {
    const db = set(writeDb$);
    const { runId, composeId } = await set(
      seedRun$,
      {
        orgId: args.orgId,
        userId: args.userId,
        triggerSource: args.triggerSource ?? "web",
        createdAt: args.createdAt,
      },
      signal,
    );
    signal.throwIfAborted();

    let threadId = args.threadId;
    if (!threadId) {
      const [thread] = await db
        .insert(chatThreads)
        .values({
          userId: args.userId,
          agentComposeId: composeId,
          title: args.title ?? null,
        })
        .returning({ id: chatThreads.id });
      signal.throwIfAborted();
      if (!thread) {
        throw new Error("seedChatThreadRun$: thread insert returned no row");
      }
      threadId = thread.id;
    }

    await db
      .update(zeroRuns)
      .set({ chatThreadId: threadId })
      .where(eq(zeroRuns.id, runId));
    signal.throwIfAborted();

    return { runId, threadId, composeId };
  },
);
