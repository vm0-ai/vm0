import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { eq, inArray } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";

interface ScheduleSeed {
  readonly name: string;
  readonly prompt: string;
  readonly cronExpression?: string;
  readonly atTime?: Date;
  readonly triggerType?: "cron" | "once" | "loop";
  readonly enabled?: boolean;
  readonly retryStartedAt?: Date | null;
  readonly consecutiveFailures?: number;
  readonly modelProviderId?: string | null;
  readonly selectedModel?: string | null;
  readonly preferPersonalProvider?: boolean;
}

interface SchedulesScenarioValues {
  readonly schedules: readonly ScheduleSeed[];
  readonly displayName?: string;
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

export const seedSchedulesScenario$ = command(
  async (
    { set },
    values: SchedulesScenarioValues,
    signal: AbortSignal,
  ): Promise<SchedulesFixture> => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const composeId = randomUUID();
    const writeDb = set(writeDb$);

    await writeDb.insert(agentComposes).values({
      id: composeId,
      userId,
      orgId,
      name: `agent-${composeId.slice(0, 8)}`,
    });
    signal.throwIfAborted();

    await writeDb.insert(zeroAgents).values({
      id: composeId,
      orgId,
      owner: userId,
      name: `agent-${composeId.slice(0, 8)}`,
      displayName: values.displayName ?? "Test Agent",
      description: null,
      sound: null,
    });
    signal.throwIfAborted();

    const scheduleIds: string[] = [];
    for (const seed of values.schedules) {
      const scheduleId = randomUUID();
      await writeDb.insert(zeroAgentSchedules).values({
        id: scheduleId,
        agentId: composeId,
        userId,
        orgId,
        name: seed.name,
        triggerType: resolveTriggerType(seed),
        cronExpression: seed.cronExpression ?? null,
        atTime: seed.atTime ?? null,
        prompt: seed.prompt,
        timezone: "UTC",
        ...(seed.enabled !== undefined && { enabled: seed.enabled }),
        ...(seed.retryStartedAt !== undefined && {
          retryStartedAt: seed.retryStartedAt,
        }),
        ...(seed.consecutiveFailures !== undefined && {
          consecutiveFailures: seed.consecutiveFailures,
        }),
        ...(seed.modelProviderId !== undefined && {
          modelProviderId: seed.modelProviderId,
        }),
        ...(seed.selectedModel !== undefined && {
          selectedModel: seed.selectedModel,
        }),
        ...(seed.preferPersonalProvider !== undefined && {
          preferPersonalProvider: seed.preferPersonalProvider,
        }),
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
    if (fixture.scheduleIds.length > 0) {
      await writeDb
        .delete(zeroAgentSchedules)
        .where(inArray(zeroAgentSchedules.id, [...fixture.scheduleIds]));
      signal.throwIfAborted();
    }
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
