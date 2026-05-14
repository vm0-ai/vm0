import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { userCache } from "@vm0/db/schema/user-cache";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq, inArray } from "drizzle-orm";

import { writeDb$, type Db } from "../../../external/db";

export interface ScheduleSeed {
  readonly name: string;
  readonly prompt: string;
  readonly cronExpression?: string;
  readonly atTime?: Date;
  readonly intervalSeconds?: number;
  readonly triggerType?: "cron" | "once" | "loop";
  readonly enabled?: boolean;
  readonly nextRunAt?: Date | null;
  readonly lastRunId?: string | null;
  readonly appendSystemPrompt?: string | null;
  readonly timezone?: string;
  readonly retryStartedAt?: Date | null;
  readonly consecutiveFailures?: number;
  readonly modelProviderId?: string | null;
  readonly selectedModel?: string | null;
  readonly preferPersonalProvider?: boolean;
}

export interface SchedulesScenarioValues {
  readonly schedules: readonly ScheduleSeed[];
  readonly displayName?: string;
  readonly agentName?: string;
  readonly userName?: string | null;
  readonly userEmail?: string | null;
  readonly timezone?: string | null;
  readonly framework?: "claude-code" | "codex";
}

function resolveTriggerType(seed: ScheduleSeed): "cron" | "once" | "loop" {
  if (seed.triggerType) {
    return seed.triggerType;
  }
  if (seed.cronExpression) {
    return "cron";
  }
  if (seed.atTime) {
    return "once";
  }
  return "loop";
}

export interface SchedulesFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly scheduleIds: readonly string[];
}

function agentEnvironment(
  framework: "claude-code" | "codex",
): Record<string, string> {
  return framework === "codex"
    ? { OPENAI_API_KEY: "test-key" }
    : { ANTHROPIC_API_KEY: "test-key" };
}

async function seedSchedule(
  writeDb: Db,
  args: {
    readonly seed: ScheduleSeed;
    readonly composeId: string;
    readonly userId: string;
    readonly orgId: string;
  },
): Promise<string> {
  const scheduleId = randomUUID();
  await writeDb.insert(zeroAgentSchedules).values({
    id: scheduleId,
    agentId: args.composeId,
    userId: args.userId,
    orgId: args.orgId,
    name: args.seed.name,
    triggerType: resolveTriggerType(args.seed),
    cronExpression: args.seed.cronExpression ?? null,
    atTime: args.seed.atTime ?? null,
    intervalSeconds: args.seed.intervalSeconds ?? null,
    prompt: args.seed.prompt,
    timezone: args.seed.timezone ?? "UTC",
    nextRunAt: args.seed.nextRunAt ?? null,
    lastRunId: args.seed.lastRunId ?? null,
    appendSystemPrompt: args.seed.appendSystemPrompt ?? null,
    enabled: args.seed.enabled ?? true,
    retryStartedAt: args.seed.retryStartedAt ?? null,
    consecutiveFailures: args.seed.consecutiveFailures ?? 0,
    modelProviderId: args.seed.modelProviderId ?? null,
    selectedModel: args.seed.selectedModel ?? null,
    preferPersonalProvider: args.seed.preferPersonalProvider ?? false,
  });
  return scheduleId;
}

export const seedSchedulesScenario$ = command(
  async (
    { set },
    values: SchedulesScenarioValues,
    signal: AbortSignal,
  ): Promise<SchedulesFixture> => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const composeId = randomUUID();
    const versionId = randomUUID();
    const writeDb = set(writeDb$);
    const agentName = values.agentName ?? `agent-${composeId.slice(0, 8)}`;
    const framework = values.framework ?? "claude-code";

    await writeDb.insert(agentComposes).values({
      id: composeId,
      userId,
      orgId,
      name: agentName,
    });
    signal.throwIfAborted();

    await writeDb.insert(agentComposeVersions).values({
      id: versionId,
      composeId,
      content: {
        version: "1.0",
        agents: {
          [agentName]: {
            framework,
            environment: agentEnvironment(framework),
          },
        },
      },
      createdBy: userId,
    });
    signal.throwIfAborted();

    await writeDb
      .update(agentComposes)
      .set({ headVersionId: versionId })
      .where(eq(agentComposes.id, composeId));
    signal.throwIfAborted();

    await writeDb.insert(zeroAgents).values({
      id: composeId,
      orgId,
      owner: userId,
      name: agentName,
      displayName: values.displayName ?? "Test Agent",
      description: null,
      sound: null,
    });
    signal.throwIfAborted();

    await writeDb.insert(userCache).values({
      userId,
      name: values.userName ?? null,
      email: values.userEmail ?? `${userId}@example.com`,
    });
    signal.throwIfAborted();

    await writeDb.insert(orgMembersMetadata).values({
      userId,
      orgId,
      timezone: values.timezone ?? null,
    });
    signal.throwIfAborted();

    const scheduleIds: string[] = [];
    for (const seed of values.schedules) {
      const scheduleId = await seedSchedule(writeDb, {
        seed,
        composeId,
        userId,
        orgId,
      });
      signal.throwIfAborted();
      scheduleIds.push(scheduleId);
    }

    return { orgId, userId, composeId, scheduleIds };
  },
);

export const deleteSchedulesScenario$ = command(
  async (
    { set },
    fixture: SchedulesFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    const runRows = await writeDb
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, fixture.orgId),
          eq(agentRuns.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
    const runIds = runRows.map((row) => {
      return row.id;
    });
    if (runIds.length > 0) {
      await writeDb
        .delete(agentRunCallbacks)
        .where(inArray(agentRunCallbacks.runId, runIds));
      signal.throwIfAborted();
      await writeDb
        .delete(runnerJobQueue)
        .where(inArray(runnerJobQueue.runId, runIds));
      signal.throwIfAborted();
      await writeDb.delete(zeroRuns).where(inArray(zeroRuns.id, runIds));
      signal.throwIfAborted();
    }

    if (fixture.scheduleIds.length > 0) {
      await writeDb
        .delete(zeroAgentSchedules)
        .where(inArray(zeroAgentSchedules.id, [...fixture.scheduleIds]));
      signal.throwIfAborted();
    }
    if (runIds.length > 0) {
      await writeDb.delete(agentRuns).where(inArray(agentRuns.id, runIds));
      signal.throwIfAborted();
    }
    await writeDb
      .delete(agentSessions)
      .where(
        and(
          eq(agentSessions.orgId, fixture.orgId),
          eq(agentSessions.userId, fixture.userId),
        ),
      );
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
    await writeDb.delete(userCache).where(eq(userCache.userId, fixture.userId));
    signal.throwIfAborted();
    await writeDb
      .delete(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, fixture.orgId),
          eq(orgMembersMetadata.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
  },
);
