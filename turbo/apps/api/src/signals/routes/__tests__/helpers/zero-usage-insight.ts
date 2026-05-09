import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq, inArray } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";
import { nowDate } from "../../../../lib/time";

export interface UsageInsightFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface ComposeResult {
  readonly composeId: string;
  readonly agentId: string;
}

interface SeedRunArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly triggerSource?: string;
  readonly scheduleId?: string;
  readonly chatThreadId?: string;
  readonly status?: string;
  readonly sandboxReuseResult?: string | null;
  readonly result?: Record<string, unknown> | null;
  readonly error?: string | null;
}

interface SeedScheduleArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly name?: string;
  readonly description?: string;
}

interface SeedChatThreadArgs {
  readonly userId: string;
  readonly composeId: string;
  readonly title?: string;
}

interface ModelUsageEventArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly creditsCharged?: number;
  readonly status?: string;
  readonly processedAt?: Date | null;
}

interface InsertUsageEventArgs {
  readonly orgId: string;
  readonly userId?: string;
  readonly runId?: string | null;
  readonly kind?: string;
  readonly provider?: string;
  readonly category?: string;
  readonly quantity?: number;
  readonly status?: string;
  readonly creditsCharged?: number;
  readonly idempotencyKey?: string;
  readonly createdAt?: Date;
  readonly processedAt?: Date | null;
}

interface BonusUsageEvent {
  readonly kind: string;
  readonly provider: string;
  readonly category: string;
  readonly quantity: number;
  readonly creditsCharged: number;
  readonly status: string;
}

interface ScheduleBatchArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly count: number;
  readonly creditsForIndex: (index: number) => number;
  readonly bonusUsageEventForIndex?: (index: number) => BonusUsageEvent | null;
}

export const seedUsageInsightFixture$ = command(
  (_, _input: void, _signal: AbortSignal): Promise<UsageInsightFixture> => {
    return Promise.resolve({
      orgId: `org_${randomUUID()}`,
      userId: `user_${randomUUID()}`,
    });
  },
);

export const deleteUsageInsightFixture$ = command(
  async (
    { set },
    fixture: UsageInsightFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const orgId = fixture.orgId;
    const userId = fixture.userId;

    await db
      .delete(usageEvent)
      .where(and(eq(usageEvent.orgId, orgId), eq(usageEvent.userId, userId)));
    signal.throwIfAborted();

    const runRows = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.userId, userId)));
    signal.throwIfAborted();
    const runIds = runRows.map((row) => {
      return row.id;
    });
    if (runIds.length > 0) {
      await db.delete(zeroRuns).where(inArray(zeroRuns.id, runIds));
      signal.throwIfAborted();
    }

    await db
      .delete(zeroAgentSchedules)
      .where(
        and(
          eq(zeroAgentSchedules.orgId, orgId),
          eq(zeroAgentSchedules.userId, userId),
        ),
      );
    signal.throwIfAborted();

    if (runIds.length > 0) {
      await db.delete(agentRuns).where(inArray(agentRuns.id, runIds));
      signal.throwIfAborted();
    }

    await db
      .delete(agentSessions)
      .where(
        and(eq(agentSessions.orgId, orgId), eq(agentSessions.userId, userId)),
      );
    signal.throwIfAborted();

    const composeRows = await db
      .select({ id: agentComposes.id })
      .from(agentComposes)
      .where(
        and(eq(agentComposes.orgId, orgId), eq(agentComposes.userId, userId)),
      );
    signal.throwIfAborted();
    const composeIds = composeRows.map((row) => {
      return row.id;
    });
    if (composeIds.length > 0) {
      await db
        .delete(agentComposeVersions)
        .where(inArray(agentComposeVersions.composeId, composeIds));
      signal.throwIfAborted();
    }

    await db.delete(chatThreads).where(eq(chatThreads.userId, userId));
    signal.throwIfAborted();

    if (composeIds.length > 0) {
      await db.delete(zeroAgents).where(inArray(zeroAgents.id, composeIds));
      signal.throwIfAborted();
    }

    await db
      .delete(agentComposes)
      .where(
        and(eq(agentComposes.orgId, orgId), eq(agentComposes.userId, userId)),
      );
    signal.throwIfAborted();
  },
);

export const seedCompose$ = command(
  async (
    { set },
    args: {
      orgId: string;
      userId: string;
      name?: string;
      displayName?: string | null;
    },
    signal: AbortSignal,
  ): Promise<ComposeResult> => {
    const db = set(writeDb$);
    const name = args.name ?? `compose-${randomUUID().slice(0, 8)}`;
    const [row] = await db
      .insert(agentComposes)
      .values({ userId: args.userId, orgId: args.orgId, name })
      .returning({ id: agentComposes.id });
    signal.throwIfAborted();
    if (!row) {
      throw new Error("seedCompose$: insert returned no row");
    }
    await db
      .insert(zeroAgents)
      .values({
        id: row.id,
        orgId: args.orgId,
        owner: args.userId,
        name,
        displayName: args.displayName ?? null,
      })
      .onConflictDoNothing();
    signal.throwIfAborted();
    return { composeId: row.id, agentId: row.id };
  },
);

export const seedRun$ = command(
  async (
    { set },
    args: SeedRunArgs,
    signal: AbortSignal,
  ): Promise<{ runId: string }> => {
    const db = set(writeDb$);
    const versionId = randomUUID();
    await db.insert(agentComposeVersions).values({
      id: versionId,
      composeId: args.composeId,
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
      .where(eq(agentComposes.id, args.composeId));
    signal.throwIfAborted();
    const [session] = await db
      .insert(agentSessions)
      .values({
        userId: args.userId,
        orgId: args.orgId,
        agentComposeId: args.composeId,
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
        prompt: "test prompt",
        status: args.status ?? "pending",
        sessionId: session.id,
        sandboxReuseResult: args.sandboxReuseResult ?? null,
        result: args.result ?? null,
        error: args.error ?? null,
      })
      .returning({ id: agentRuns.id });
    signal.throwIfAborted();
    if (!run) {
      throw new Error("seedRun$: run insert returned no row");
    }
    await db.insert(zeroRuns).values({
      id: run.id,
      triggerSource: args.triggerSource ?? "cli",
      scheduleId: args.scheduleId ?? null,
      chatThreadId: args.chatThreadId ?? null,
    });
    signal.throwIfAborted();
    return { runId: run.id };
  },
);

// A run whose agent_compose_version_id is null — mirrors web's
// seedOrphanTestRun. Tests the leftJoin path where compose+agent are missing
// (response has agentId/framework/displayName all null).
export const seedOrphanRun$ = command(
  async (
    { set },
    args: { orgId: string; userId: string; prompt?: string },
    signal: AbortSignal,
  ): Promise<{ runId: string }> => {
    const db = set(writeDb$);
    // Throwaway compose for the session FK; the run itself has no version.
    const [compose] = await db
      .insert(agentComposes)
      .values({
        userId: args.userId,
        orgId: args.orgId,
        name: `orphan-${randomUUID().slice(0, 8)}`,
      })
      .returning({ id: agentComposes.id });
    signal.throwIfAborted();
    if (!compose) {
      throw new Error("seedOrphanRun$: compose insert returned no row");
    }
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
      throw new Error("seedOrphanRun$: session insert returned no row");
    }
    const [run] = await db
      .insert(agentRuns)
      .values({
        userId: args.userId,
        orgId: args.orgId,
        agentComposeVersionId: null,
        prompt: args.prompt ?? "orphan run prompt",
        status: "completed",
        sessionId: session.id,
      })
      .returning({ id: agentRuns.id });
    signal.throwIfAborted();
    if (!run) {
      throw new Error("seedOrphanRun$: run insert returned no row");
    }
    await db.insert(zeroRuns).values({
      id: run.id,
      triggerSource: "cli",
      scheduleId: null,
      chatThreadId: null,
    });
    signal.throwIfAborted();
    return { runId: run.id };
  },
);

export const seedSchedule$ = command(
  async (
    { set },
    args: SeedScheduleArgs,
    signal: AbortSignal,
  ): Promise<string> => {
    const db = set(writeDb$);
    const [row] = await db
      .insert(zeroAgentSchedules)
      .values({
        agentId: args.agentId,
        userId: args.userId,
        orgId: args.orgId,
        name: args.name ?? `sched-${randomUUID().slice(0, 8)}`,
        description: args.description,
        cronExpression: "0 0 * * *",
        prompt: "test",
      })
      .returning({ id: zeroAgentSchedules.id });
    signal.throwIfAborted();
    if (!row) {
      throw new Error("seedSchedule$: insert returned no row");
    }
    return row.id;
  },
);

export const seedChatThread$ = command(
  async (
    { set },
    args: SeedChatThreadArgs,
    signal: AbortSignal,
  ): Promise<string> => {
    const db = set(writeDb$);
    const [row] = await db
      .insert(chatThreads)
      .values({
        userId: args.userId,
        agentComposeId: args.composeId,
        title: args.title ?? null,
      })
      .returning({ id: chatThreads.id });
    signal.throwIfAborted();
    if (!row) {
      throw new Error("seedChatThread$: insert returned no row");
    }
    return row.id;
  },
);

const MODEL_TOKEN_CATEGORIES = [
  "tokens.input",
  "tokens.output",
  "tokens.cache_read",
  "tokens.cache_creation",
] as const;

interface ModelRowQuantity {
  readonly category: (typeof MODEL_TOKEN_CATEGORIES)[number];
  readonly quantity: number;
}

function buildModelUsageRows(args: ModelUsageEventArgs): {
  rows: {
    runId: string;
    orgId: string;
    userId: string;
    kind: string;
    provider: string;
    category: string;
    quantity: number;
    creditsCharged: number | null;
    status: string;
    idempotencyKey: string;
    createdAt: Date;
    processedAt: Date | null;
  }[];
} {
  const status = args.status ?? "pending";
  const createdAt = nowDate();
  const processedAt =
    args.processedAt !== undefined
      ? args.processedAt
      : status === "processed"
        ? createdAt
        : null;
  const provider = "claude-sonnet-4-6";
  const quantities: readonly ModelRowQuantity[] = [
    { category: "tokens.input", quantity: args.inputTokens ?? 0 },
    { category: "tokens.output", quantity: args.outputTokens ?? 0 },
    { category: "tokens.cache_read", quantity: args.cacheReadInputTokens ?? 0 },
    {
      category: "tokens.cache_creation",
      quantity: args.cacheCreationInputTokens ?? 0,
    },
  ];
  const billable = quantities.filter((entry, index) => {
    return index === 0 || entry.quantity > 0;
  });
  const rows = billable.map((entry, index) => {
    return {
      runId: args.runId,
      orgId: args.orgId,
      userId: args.userId,
      kind: "model",
      provider,
      category: entry.category,
      quantity: entry.quantity,
      creditsCharged: index === 0 ? (args.creditsCharged ?? null) : null,
      status,
      idempotencyKey: randomUUID(),
      createdAt,
      processedAt,
    };
  });
  return { rows };
}

export const insertModelUsageEventForRun$ = command(
  async (
    { set },
    args: ModelUsageEventArgs,
    signal: AbortSignal,
  ): Promise<{ id: string }> => {
    const db = set(writeDb$);
    const { rows } = buildModelUsageRows({
      ...args,
      inputTokens: args.inputTokens ?? 100,
      outputTokens: args.outputTokens ?? 50,
    });
    const [row] = await db
      .insert(usageEvent)
      .values(rows)
      .returning({ id: usageEvent.id });
    signal.throwIfAborted();
    if (!row) {
      throw new Error("insertModelUsageEventForRun$: returned no row");
    }
    return { id: row.id };
  },
);

export const insertUsageEvent$ = command(
  async (
    { set },
    args: InsertUsageEventArgs,
    signal: AbortSignal,
  ): Promise<string> => {
    const db = set(writeDb$);
    const status = args.status ?? "pending";
    const processedAt =
      args.processedAt !== undefined
        ? args.processedAt
        : status === "processed"
          ? nowDate()
          : null;
    const values: typeof usageEvent.$inferInsert = {
      runId: args.runId ?? null,
      orgId: args.orgId,
      userId: args.userId ?? "test-user",
      kind: args.kind ?? "connector",
      provider: args.provider ?? "x",
      category: args.category ?? "tweet.read",
      quantity: args.quantity ?? 1,
      status,
      creditsCharged: args.creditsCharged ?? null,
      idempotencyKey: args.idempotencyKey ?? randomUUID(),
      processedAt,
    };
    if (args.createdAt) {
      values.createdAt = args.createdAt;
    }
    const [row] = await db
      .insert(usageEvent)
      .values(values)
      .returning({ id: usageEvent.id });
    signal.throwIfAborted();
    if (!row) {
      throw new Error("insertUsageEvent$: insert returned no row");
    }
    return row.id;
  },
);

export const setUsageEventCreatedAt$ = command(
  async (
    { set },
    args: { id: string; createdAt: Date },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const [row] = await db
      .select({
        runId: usageEvent.runId,
        originalCreatedAt: usageEvent.createdAt,
      })
      .from(usageEvent)
      .where(eq(usageEvent.id, args.id))
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      return;
    }
    const where = row.runId
      ? and(
          eq(usageEvent.runId, row.runId),
          eq(usageEvent.createdAt, row.originalCreatedAt),
        )
      : eq(usageEvent.id, args.id);
    await db.update(usageEvent).set({ createdAt: args.createdAt }).where(where);
    signal.throwIfAborted();
  },
);

export const seedScheduleBatch$ = command(
  async (
    { set },
    args: ScheduleBatchArgs,
    signal: AbortSignal,
  ): Promise<{ scheduleIds: string[] }> => {
    const db = set(writeDb$);
    const indices = Array.from({ length: args.count }, (_, index) => {
      return index;
    });
    const results = await Promise.all(
      indices.map(async (index) => {
        const [scheduleRow] = await db
          .insert(zeroAgentSchedules)
          .values({
            agentId: args.composeId,
            userId: args.userId,
            orgId: args.orgId,
            name: `sched-${randomUUID().slice(0, 8)}`,
            cronExpression: "0 0 * * *",
            prompt: "test",
          })
          .returning({ id: zeroAgentSchedules.id });
        if (!scheduleRow) {
          throw new Error(
            "seedScheduleBatch$: schedule insert returned no row",
          );
        }
        const versionId = randomUUID();
        await db.insert(agentComposeVersions).values({
          id: versionId,
          composeId: args.composeId,
          content: {
            version: "1.0",
            agents: { "test-agent": { framework: "claude-code" } },
          },
          createdBy: args.userId,
        });
        const [session] = await db
          .insert(agentSessions)
          .values({
            userId: args.userId,
            orgId: args.orgId,
            agentComposeId: args.composeId,
          })
          .returning({ id: agentSessions.id });
        if (!session) {
          throw new Error("seedScheduleBatch$: session insert returned no row");
        }
        const [run] = await db
          .insert(agentRuns)
          .values({
            userId: args.userId,
            orgId: args.orgId,
            agentComposeVersionId: versionId,
            prompt: "test prompt",
            status: "completed",
            sessionId: session.id,
          })
          .returning({ id: agentRuns.id });
        if (!run) {
          throw new Error("seedScheduleBatch$: run insert returned no row");
        }
        await db.insert(zeroRuns).values({
          id: run.id,
          triggerSource: "schedule",
          scheduleId: scheduleRow.id,
        });
        const credits = args.creditsForIndex(index);
        await db.insert(usageEvent).values({
          runId: run.id,
          orgId: args.orgId,
          userId: args.userId,
          kind: "model",
          provider: "claude-sonnet-4-6",
          category: "tokens.input",
          quantity: 100,
          creditsCharged: credits,
          status: "processed",
          idempotencyKey: randomUUID(),
          processedAt: nowDate(),
        });
        const bonus = args.bonusUsageEventForIndex?.(index);
        if (bonus) {
          await db.insert(usageEvent).values({
            runId: run.id,
            orgId: args.orgId,
            userId: args.userId,
            kind: bonus.kind,
            provider: bonus.provider,
            category: bonus.category,
            quantity: bonus.quantity,
            creditsCharged: bonus.creditsCharged,
            status: bonus.status,
            idempotencyKey: randomUUID(),
            processedAt: bonus.status === "processed" ? nowDate() : null,
          });
        }
        return scheduleRow.id;
      }),
    );
    signal.throwIfAborted();
    return { scheduleIds: results };
  },
);
