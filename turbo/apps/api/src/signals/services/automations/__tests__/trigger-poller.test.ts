import { randomUUID } from "node:crypto";

import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { automations, automationTriggers } from "@vm0/db/schema/automation";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { createStore } from "ccstate";
import { desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { testContext } from "../../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { clearMockNow, mockNow, nowDate } from "../../../../lib/time";
import { writeDb$ } from "../../../external/db";
import {
  deleteSchedulesScenario$,
  seedSchedulesScenario$,
  type SchedulesFixture,
} from "../../../routes/__tests__/helpers/zero-schedules";
import { createFixtureTracker } from "../../../routes/__tests__/helpers/zero-route-test";
import { executeDueTriggers$ } from "../trigger-poller";

const context = testContext();
const store = createStore();

const BASE_TIME = Date.parse("2000-01-01T08:00:00.000Z");
const DUE_TIME = Date.parse("2000-01-01T09:01:00.000Z");

interface TriggerSeed {
  readonly kind: "cron" | "once" | "loop";
  readonly cronExpression?: string;
  readonly atTime?: Date;
  readonly intervalSeconds?: number;
  readonly nextRunAt?: Date | null;
  readonly enabled?: boolean;
  readonly consecutiveFailures?: number;
  readonly lastRunId?: string | null;
}

interface AutomationFixture {
  readonly schedules: SchedulesFixture;
  readonly automationId: string;
  readonly triggerId: string;
  readonly threadId: string;
}

const trackSchedules = createFixtureTracker<SchedulesFixture>((fixture) => {
  return store.set(deleteSchedulesScenario$, fixture, context.signal);
});

const trackAutomation = createFixtureTracker<AutomationFixture>(
  async (fixture) => {
    const db = store.set(writeDb$);
    await db
      .delete(automationTriggers)
      .where(eq(automationTriggers.id, fixture.triggerId));
    await db
      .delete(automations)
      .where(eq(automations.id, fixture.automationId));
    await db.delete(chatThreads).where(eq(chatThreads.id, fixture.threadId));
  },
);

function dueDate(): Date {
  return new Date(DUE_TIME - 60 * 1000);
}

async function seedAutomationTrigger(
  seed: TriggerSeed,
  options?: { readonly automationEnabled?: boolean },
): Promise<AutomationFixture> {
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  context.mocks.s3.send.mockResolvedValue({});

  const schedules = await trackSchedules(
    store.set(
      seedSchedulesScenario$,
      {
        userName: "Automation Owner",
        userEmail: "automation-owner@example.com",
        schedules: [],
      },
      context.signal,
    ),
  );

  const db = store.set(writeDb$);
  const [thread] = await db
    .insert(chatThreads)
    .values({
      userId: schedules.userId,
      agentComposeId: schedules.composeId,
      title: "automation thread",
    })
    .returning({ id: chatThreads.id });
  if (!thread) {
    throw new Error(
      "seedAutomationTrigger: chat thread insert returned no row",
    );
  }

  const [automation] = await db
    .insert(automations)
    .values({
      orgId: schedules.orgId,
      userId: schedules.userId,
      name: `time-automation-${randomUUID().slice(0, 8)}`,
      instruction: "Summarize the latest project status.",
      agentId: schedules.composeId,
      chatThreadId: thread.id,
      interpreterKind: "time",
      enabled: options?.automationEnabled ?? true,
    })
    .returning({ id: automations.id });
  if (!automation) {
    throw new Error("seedAutomationTrigger: automation insert returned no row");
  }

  const [trigger] = await db
    .insert(automationTriggers)
    .values({
      automationId: automation.id,
      kind: seed.kind,
      cronExpression: seed.cronExpression ?? null,
      atTime: seed.atTime ?? null,
      intervalSeconds: seed.intervalSeconds ?? null,
      nextRunAt: seed.nextRunAt ?? null,
      enabled: seed.enabled ?? true,
      consecutiveFailures: seed.consecutiveFailures ?? 0,
      lastRunId: seed.lastRunId ?? null,
    })
    .returning({ id: automationTriggers.id });
  if (!trigger) {
    throw new Error("seedAutomationTrigger: trigger insert returned no row");
  }

  return await trackAutomation(
    Promise.resolve({
      schedules,
      automationId: automation.id,
      triggerId: trigger.id,
      threadId: thread.id,
    }),
  );
}

async function findTrigger(triggerId: string) {
  const db = store.set(writeDb$);
  const [trigger] = await db
    .select()
    .from(automationTriggers)
    .where(eq(automationTriggers.id, triggerId));
  return trigger;
}

async function findAutomationRuns(automationId: string) {
  const db = store.set(writeDb$);
  return await db
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      prompt: agentRuns.prompt,
      appendSystemPrompt: agentRuns.appendSystemPrompt,
      triggerSource: zeroRuns.triggerSource,
      automationId: zeroRuns.automationId,
      triggerId: zeroRuns.triggerId,
    })
    .from(agentRuns)
    .innerJoin(zeroRuns, eq(agentRuns.id, zeroRuns.id))
    .where(eq(zeroRuns.automationId, automationId))
    .orderBy(desc(agentRuns.createdAt));
}

async function composeHeadVersionId(composeId: string): Promise<string> {
  const db = store.set(writeDb$);
  const [compose] = await db
    .select({ headVersionId: agentComposes.headVersionId })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId));
  if (!compose?.headVersionId) {
    throw new Error("composeHeadVersionId: missing headVersionId");
  }
  return compose.headVersionId;
}

async function insertBlockingRun(fixture: AutomationFixture): Promise<string> {
  const db = store.set(writeDb$);
  const [session] = await db
    .insert(agentSessions)
    .values({
      userId: fixture.schedules.userId,
      orgId: fixture.schedules.orgId,
      agentComposeId: fixture.schedules.composeId,
    })
    .returning({ id: agentSessions.id });
  if (!session) {
    throw new Error("insertBlockingRun: session insert returned no row");
  }

  const headVersionId = await composeHeadVersionId(fixture.schedules.composeId);
  const [run] = await db
    .insert(agentRuns)
    .values({
      userId: fixture.schedules.userId,
      orgId: fixture.schedules.orgId,
      agentComposeVersionId: headVersionId,
      sessionId: session.id,
      status: "running",
      prompt: `Blocking run ${randomUUID()}`,
      createdAt: nowDate(),
    })
    .returning({ id: agentRuns.id });
  if (!run) {
    throw new Error("insertBlockingRun: run insert returned no row");
  }
  return run.id;
}

async function clearComposeHeadVersion(composeId: string): Promise<void> {
  const db = store.set(writeDb$);
  await db
    .update(agentComposes)
    .set({ headVersionId: null })
    .where(eq(agentComposes.id, composeId));
}

describe("executeDueTriggers$ (dormant automation time poller)", () => {
  beforeEach(() => {
    mockEnv("VM0_API_URL", "https://api.example.test");
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    context.mocks.s3.send.mockResolvedValue({});
    mockNow(BASE_TIME);
  });

  afterEach(() => {
    clearMockNow();
  });

  it("ignores triggers whose next run is in the future", async () => {
    const fixture = await seedAutomationTrigger({
      kind: "cron",
      cronExpression: "0 9 * * *",
      nextRunAt: new Date("2000-01-02T09:00:00.000Z"),
    });
    mockNow(DUE_TIME);

    const result = await store.set(executeDueTriggers$, context.signal);

    expect(result).toStrictEqual({ executed: 0, skipped: 0 });
    const runs = await findAutomationRuns(fixture.automationId);
    expect(runs).toHaveLength(0);
  });

  it("executes a due cron trigger, advances next run, and tags provenance", async () => {
    const fixture = await seedAutomationTrigger({
      kind: "cron",
      cronExpression: "0 9 * * *",
      nextRunAt: dueDate(),
    });
    mockNow(DUE_TIME);

    const result = await store.set(executeDueTriggers$, context.signal);

    expect(result.executed).toBe(1);
    const trigger = await findTrigger(fixture.triggerId);
    expect(trigger?.enabled).toBeTruthy();
    expect(trigger?.lastRunAt).not.toBeNull();
    // Cron advances to the next occurrence (next day 09:00 UTC).
    expect(trigger?.nextRunAt).toStrictEqual(
      new Date("2000-01-02T09:00:00.000Z"),
    );
    expect(trigger?.lastRunId).not.toBeNull();

    const runs = await findAutomationRuns(fixture.automationId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.prompt).toBe("Summarize the latest project status.");
    expect(runs[0]?.triggerSource).toBe("schedule");
    expect(runs[0]?.automationId).toBe(fixture.automationId);
    expect(runs[0]?.triggerId).toBe(fixture.triggerId);
    expect(runs[0]?.appendSystemPrompt).toContain(
      "# Current Integration\nYou are currently running inside: Schedule",
    );
    expect(runs[0]?.appendSystemPrompt).toContain("Trigger type: cron");
  });

  it("executes and disables a due one-time trigger", async () => {
    const fixture = await seedAutomationTrigger({
      kind: "once",
      atTime: dueDate(),
      nextRunAt: dueDate(),
    });
    mockNow(DUE_TIME);

    const result = await store.set(executeDueTriggers$, context.signal);

    expect(result.executed).toBe(1);
    const trigger = await findTrigger(fixture.triggerId);
    expect(trigger?.enabled).toBeFalsy();
    expect(trigger?.nextRunAt).toBeNull();
    expect(trigger?.lastRunAt).not.toBeNull();
    const runs = await findAutomationRuns(fixture.automationId);
    expect(runs).toHaveLength(1);
  });

  it("executes a due loop trigger and advances by its interval", async () => {
    const fixture = await seedAutomationTrigger({
      kind: "loop",
      intervalSeconds: 300,
      nextRunAt: dueDate(),
    });
    mockNow(DUE_TIME);

    const result = await store.set(executeDueTriggers$, context.signal);

    expect(result.executed).toBe(1);
    const trigger = await findTrigger(fixture.triggerId);
    expect(trigger?.enabled).toBeTruthy();
    expect(trigger?.lastRunAt).not.toBeNull();
    expect(trigger?.nextRunAt).toStrictEqual(new Date(DUE_TIME + 300_000));
    const runs = await findAutomationRuns(fixture.automationId);
    expect(runs).toHaveLength(1);
  });

  it("does not create duplicate runs for concurrent invocations", async () => {
    const fixture = await seedAutomationTrigger({
      kind: "cron",
      cronExpression: "0 9 * * *",
      nextRunAt: dueDate(),
    });
    mockNow(DUE_TIME);

    const [first, second] = await Promise.all([
      store.set(executeDueTriggers$, context.signal),
      store.set(executeDueTriggers$, context.signal),
    ]);

    expect(first.executed + second.executed).toBe(1);
    const runs = await findAutomationRuns(fixture.automationId);
    expect(runs).toHaveLength(1);
  });

  it("skips a due trigger while its previous run is still active", async () => {
    const fixture = await seedAutomationTrigger({
      kind: "cron",
      cronExpression: "0 9 * * *",
      nextRunAt: dueDate(),
    });
    const activeRunId = await insertBlockingRun(fixture);
    const db = store.set(writeDb$);
    await db
      .update(automationTriggers)
      .set({ lastRunId: activeRunId })
      .where(eq(automationTriggers.id, fixture.triggerId));
    mockNow(DUE_TIME);

    const result = await store.set(executeDueTriggers$, context.signal);

    expect(result).toMatchObject({ executed: 0, skipped: 1 });
    const trigger = await findTrigger(fixture.triggerId);
    // Not claimed: next run unchanged.
    expect(trigger?.nextRunAt).toStrictEqual(dueDate());
    const runs = await findAutomationRuns(fixture.automationId);
    expect(runs).toHaveLength(0);
  });

  it("skips a due trigger whose automation is disabled", async () => {
    const fixture = await seedAutomationTrigger(
      {
        kind: "cron",
        cronExpression: "0 9 * * *",
        nextRunAt: dueDate(),
      },
      { automationEnabled: false },
    );
    mockNow(DUE_TIME);

    const result = await store.set(executeDueTriggers$, context.signal);

    expect(result).toMatchObject({ executed: 0, skipped: 1 });
    const trigger = await findTrigger(fixture.triggerId);
    expect(trigger?.nextRunAt).toStrictEqual(dueDate());
    const runs = await findAutomationRuns(fixture.automationId);
    expect(runs).toHaveLength(0);
  });

  it("advances a cron trigger after a pre-run failure", async () => {
    const fixture = await seedAutomationTrigger({
      kind: "cron",
      cronExpression: "0 9 * * *",
      nextRunAt: dueDate(),
    });
    await clearComposeHeadVersion(fixture.schedules.composeId);
    mockNow(DUE_TIME);

    const result = await store.set(executeDueTriggers$, context.signal);

    expect(result).toMatchObject({ executed: 0, skipped: 1 });
    const trigger = await findTrigger(fixture.triggerId);
    expect(trigger?.consecutiveFailures).toBe(1);
    expect(trigger?.enabled).toBeTruthy();
    expect(trigger?.nextRunAt?.getTime()).toBeGreaterThan(DUE_TIME);
    const runs = await findAutomationRuns(fixture.automationId);
    expect(runs).toHaveLength(0);
  });

  it("auto-disables a trigger after three consecutive pre-run failures", async () => {
    const fixture = await seedAutomationTrigger({
      kind: "cron",
      cronExpression: "0 9 * * *",
      nextRunAt: dueDate(),
      consecutiveFailures: 2,
    });
    await clearComposeHeadVersion(fixture.schedules.composeId);
    mockNow(DUE_TIME);

    const result = await store.set(executeDueTriggers$, context.signal);

    expect(result).toMatchObject({ executed: 0, skipped: 1 });
    const trigger = await findTrigger(fixture.triggerId);
    expect(trigger?.consecutiveFailures).toBe(3);
    expect(trigger?.enabled).toBeFalsy();
    expect(trigger?.nextRunAt).toBeNull();
  });
});
