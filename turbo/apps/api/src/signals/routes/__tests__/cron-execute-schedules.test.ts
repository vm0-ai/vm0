import { randomUUID } from "node:crypto";

import { cronExecuteSchedulesContract } from "@vm0/api-contracts/contracts/cron";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { automations, automationTriggers } from "@vm0/db/schema/automation";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { createStore } from "ccstate";
import { and, desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, nowDate } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import { syncScheduleToAutomationSafely } from "../../services/automations/schedule-dual-write";
import { executeDueSchedules$ } from "../../services/zero-schedules.service";
import {
  deleteSchedulesScenario$,
  seedSchedulesScenario$,
  type ScheduleSeed,
  type SchedulesFixture,
} from "./helpers/zero-schedules";
import { createFixtureTracker } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const CRON_SECRET = "test-cron-secret";
const BASE_TIME = Date.parse("2000-01-01T08:00:00.000Z");
const DUE_TIME = Date.parse("2000-01-01T09:01:00.000Z");

const track = createFixtureTracker<SchedulesFixture>((fixture) => {
  return store.set(deleteSchedulesScenario$, fixture, context.signal);
});

function apiClient() {
  return setupApp({ context })(cronExecuteSchedulesContract);
}

function cronHeaders(secret = CRON_SECRET) {
  return { authorization: `Bearer ${secret}` };
}

function dueDate(): Date {
  return new Date(DUE_TIME - 60 * 1000);
}

async function seedFixture(
  schedules: readonly ScheduleSeed[],
): Promise<SchedulesFixture> {
  return await track(
    store.set(
      seedSchedulesScenario$,
      {
        userName: "Schedule Owner",
        userEmail: "schedule-owner@example.com",
        timezone: "UTC",
        schedules,
      },
      context.signal,
    ),
  );
}

// Mirror a seeded schedule into the events-first tables, as the dual-write
// would have on deploy. Post-cutover the cron route polls the trigger table,
// so a schedule only fires through its mirror.
async function mirrorSchedule(scheduleId: string): Promise<void> {
  const db = store.set(writeDb$);
  const [schedule] = await db
    .select()
    .from(zeroAgentSchedules)
    .where(eq(zeroAgentSchedules.id, scheduleId));
  if (!schedule) {
    throw new Error("mirrorSchedule: schedule not found");
  }
  await syncScheduleToAutomationSafely(db, schedule);
}

async function findSchedule(scheduleId: string) {
  const db = store.set(writeDb$);
  const [schedule] = await db
    .select()
    .from(zeroAgentSchedules)
    .where(eq(zeroAgentSchedules.id, scheduleId));
  return schedule;
}

async function findMirrorTrigger(scheduleId: string) {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({ trigger: automationTriggers, automationId: automations.id })
    .from(automations)
    .innerJoin(
      automationTriggers,
      eq(automationTriggers.automationId, automations.id),
    )
    .where(eq(automations.sourceScheduleId, scheduleId));
  return row;
}

// Runs created post-cutover carry automation/trigger provenance (not
// scheduleId), so look them up through the schedule's mirror.
async function findMirrorRuns(scheduleId: string) {
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
    .innerJoin(automations, eq(zeroRuns.automationId, automations.id))
    .where(eq(automations.sourceScheduleId, scheduleId))
    .orderBy(desc(agentRuns.createdAt));
}

async function findRunCallbackUrls(runId: string): Promise<string[]> {
  const db = store.set(writeDb$);
  const rows = await db
    .select({ url: agentRunCallbacks.url })
    .from(agentRunCallbacks)
    .where(eq(agentRunCallbacks.runId, runId));
  return rows.map((row) => {
    return row.url;
  });
}

async function findUserMessage(runId: string) {
  const db = store.set(writeDb$);
  const [message] = await db
    .select({
      scheduleId: chatMessages.scheduleId,
      scheduleTitle: chatMessages.scheduleTitle,
      scheduleSnapshot: chatMessages.scheduleSnapshot,
    })
    .from(chatMessages)
    .where(and(eq(chatMessages.runId, runId), eq(chatMessages.role, "user")));
  return message;
}

async function clearComposeHeadVersion(composeId: string): Promise<void> {
  const db = store.set(writeDb$);
  await db
    .update(agentComposes)
    .set({ headVersionId: null })
    .where(eq(agentComposes.id, composeId));
}

async function insertBlockingRun(fixture: SchedulesFixture): Promise<string> {
  const db = store.set(writeDb$);
  const [compose] = await db
    .select({ headVersionId: agentComposes.headVersionId })
    .from(agentComposes)
    .where(eq(agentComposes.id, fixture.composeId));
  if (!compose?.headVersionId) {
    throw new Error("Fixture compose is missing headVersionId");
  }

  const [session] = await db
    .insert(agentSessions)
    .values({
      userId: fixture.userId,
      orgId: fixture.orgId,
      agentComposeId: fixture.composeId,
    })
    .returning({ id: agentSessions.id });
  if (!session) {
    throw new Error("Session insert returned no row");
  }

  const [run] = await db
    .insert(agentRuns)
    .values({
      userId: fixture.userId,
      orgId: fixture.orgId,
      agentComposeVersionId: compose.headVersionId,
      sessionId: session.id,
      status: "pending",
      prompt: `Blocking run ${randomUUID()}`,
      createdAt: nowDate(),
    })
    .returning({ id: agentRuns.id });
  if (!run) {
    throw new Error("Run insert returned no row");
  }
  return run.id;
}

describe("GET /api/cron/execute-schedules (trigger-table poller)", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", CRON_SECRET);
    mockEnv("VM0_API_URL", "https://api.example.test");
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    context.mocks.s3.send.mockResolvedValue({});
    mockNow(BASE_TIME);
  });

  afterEach(() => {
    clearMockNow();
  });

  it("rejects requests with an invalid cron secret", async () => {
    const response = await accept(
      apiClient().execute({ headers: cronHeaders("wrong-secret") }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });

  it("rejects requests with no authorization header", async () => {
    const response = await accept(apiClient().execute({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });

  it("returns execution counts when no triggers are due", async () => {
    const fixture = await seedFixture([
      {
        name: "future-cron",
        prompt: "Future task",
        cronExpression: "0 9 * * *",
        nextRunAt: new Date("2000-01-02T09:00:00.000Z"),
      },
    ]);
    await mirrorSchedule(fixture.scheduleIds[0]!);
    mockNow(DUE_TIME);

    const response = await accept(
      apiClient().execute({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      executed: 0,
      skipped: 0,
    });
  });

  it("does not fire a schedule that has no mirror", async () => {
    // The cutover dependency: the route polls automation_triggers, so a
    // schedule the backfill/dual-write missed cannot fire. The reconciliation
    // query is the pre-flip gate for exactly this.
    const fixture = await seedFixture([
      {
        name: "unmirrored-cron",
        prompt: "Unmirrored task",
        cronExpression: "0 9 * * *",
        nextRunAt: dueDate(),
      },
    ]);
    mockNow(DUE_TIME);

    const response = await accept(
      apiClient().execute({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toMatchObject({ executed: 0, skipped: 0 });
    const runs = await findMirrorRuns(fixture.scheduleIds[0]!);
    expect(runs).toHaveLength(0);
  });

  it("executes a due cron trigger and leaves advancement to the callback", async () => {
    const fixture = await seedFixture([
      {
        name: "due-cron",
        prompt: "Daily task",
        cronExpression: "0 9 * * *",
        nextRunAt: dueDate(),
      },
    ]);
    const scheduleId = fixture.scheduleIds[0]!;
    await mirrorSchedule(scheduleId);
    mockNow(DUE_TIME);

    const response = await accept(
      apiClient().execute({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.executed).toBe(1);
    const mirror = await findMirrorTrigger(scheduleId);
    expect(mirror?.trigger.enabled).toBeTruthy();
    expect(mirror?.trigger.lastRunAt).not.toBeNull();
    expect(mirror?.trigger.nextRunAt).toBeNull();
    expect(mirror?.trigger.lastRunId).not.toBeNull();

    const runs = await findMirrorRuns(scheduleId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.prompt).toBe("Daily task");
    expect(runs[0]?.triggerSource).toBe("schedule");
    expect(runs[0]?.automationId).toBe(mirror?.automationId);
    expect(runs[0]?.triggerId).toBe(mirror?.trigger.id);

    // The old table is no longer written by the poller; its runtime state
    // stays as-was until the compat reads cut over (phase 3).
    const schedule = await findSchedule(scheduleId);
    expect(schedule?.nextRunAt).toStrictEqual(dueDate());

    // The run carries the trigger-keyed reschedule callback + the chat
    // callback, and its chat bubble keeps the schedule chip: scheduleId links
    // the mirrored source schedule, the snapshot labels the message.
    const runId = runs[0]?.id;
    expect(runId).toBeDefined();
    if (!runId) {
      return;
    }
    const callbackUrls = await findRunCallbackUrls(runId);
    expect(
      callbackUrls.some((url) => {
        return url.endsWith("/api/internal/callbacks/trigger/cron");
      }),
    ).toBeTruthy();
    expect(
      callbackUrls.some((url) => {
        return url.endsWith("/api/internal/callbacks/chat");
      }),
    ).toBeTruthy();
    const message = await findUserMessage(runId);
    expect(message?.scheduleId).toBe(scheduleId);
    expect(message?.scheduleTitle).toBe("due-cron");
    expect(message?.scheduleSnapshot).toStrictEqual({
      id: scheduleId,
      title: "due-cron",
      description: null,
    });
  });

  it("does not create duplicate runs for concurrent cron invocations", async () => {
    const fixture = await seedFixture([
      {
        name: "concurrent-cron",
        prompt: "Concurrent task",
        cronExpression: "0 9 * * *",
        nextRunAt: dueDate(),
      },
    ]);
    const scheduleId = fixture.scheduleIds[0]!;
    await mirrorSchedule(scheduleId);
    mockNow(DUE_TIME);

    const [first, second] = await Promise.all([
      accept(apiClient().execute({ headers: cronHeaders() }), [200]),
      accept(apiClient().execute({ headers: cronHeaders() }), [200]),
    ]);

    expect(first.body.executed + second.body.executed).toBe(1);
    const runs = await findMirrorRuns(scheduleId);
    expect(runs).toHaveLength(1);
  });

  it("executes and disables a due one-time trigger", async () => {
    const fixture = await seedFixture([
      {
        name: "due-once",
        prompt: "One-time task",
        atTime: dueDate(),
        nextRunAt: dueDate(),
      },
    ]);
    const scheduleId = fixture.scheduleIds[0]!;
    await mirrorSchedule(scheduleId);
    mockNow(DUE_TIME);

    const response = await accept(
      apiClient().execute({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.executed).toBe(1);
    const mirror = await findMirrorTrigger(scheduleId);
    expect(mirror?.trigger.enabled).toBeFalsy();
    expect(mirror?.trigger.nextRunAt).toBeNull();
    expect(mirror?.trigger.lastRunAt).not.toBeNull();
    const runs = await findMirrorRuns(scheduleId);
    expect(runs).toHaveLength(1);
  });

  it("passes appendSystemPrompt from the mirrored schedule to the created run", async () => {
    const fixture = await seedFixture([
      {
        name: "append-prompt",
        prompt: "Prompt task",
        cronExpression: "0 9 * * *",
        nextRunAt: dueDate(),
        appendSystemPrompt: "Always respond in formal tone",
      },
    ]);
    const scheduleId = fixture.scheduleIds[0]!;
    await mirrorSchedule(scheduleId);
    mockNow(DUE_TIME);

    await accept(apiClient().execute({ headers: cronHeaders() }), [200]);

    const runs = await findMirrorRuns(scheduleId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.appendSystemPrompt).toContain(
      "# Current Integration\nYou are currently running inside: Schedule",
    );
    expect(runs[0]?.appendSystemPrompt).toContain("Trigger type: cron");
    expect(runs[0]?.appendSystemPrompt).toContain(
      "Always respond in formal tone",
    );
  });

  it("executes a due loop trigger and waits for the callback to set the next run", async () => {
    const fixture = await seedFixture([
      {
        name: "due-loop",
        prompt: "Loop task",
        intervalSeconds: 300,
        nextRunAt: dueDate(),
      },
    ]);
    const scheduleId = fixture.scheduleIds[0]!;
    await mirrorSchedule(scheduleId);
    mockNow(DUE_TIME);

    const response = await accept(
      apiClient().execute({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.executed).toBe(1);
    const mirror = await findMirrorTrigger(scheduleId);
    expect(mirror?.trigger.enabled).toBeTruthy();
    expect(mirror?.trigger.lastRunAt).not.toBeNull();
    expect(mirror?.trigger.nextRunAt).toBeNull();

    const runs = await findMirrorRuns(scheduleId);
    const runId = runs[0]?.id;
    expect(runId).toBeDefined();
    if (!runId) {
      return;
    }
    const callbackUrls = await findRunCallbackUrls(runId);
    expect(
      callbackUrls.some((url) => {
        return url.endsWith("/api/internal/callbacks/trigger/loop");
      }),
    ).toBeTruthy();
  });

  it("skips a due trigger whose automation is disabled", async () => {
    const fixture = await seedFixture([
      {
        name: "automation-disabled",
        prompt: "Suspended task",
        cronExpression: "0 9 * * *",
        nextRunAt: dueDate(),
      },
    ]);
    const scheduleId = fixture.scheduleIds[0]!;
    await mirrorSchedule(scheduleId);
    // A disabled automation suspends all its triggers without touching their
    // own enabled flag (mirrors the webhook dispatch's automation gate).
    const db = store.set(writeDb$);
    await db
      .update(automations)
      .set({ enabled: false })
      .where(eq(automations.sourceScheduleId, scheduleId));
    mockNow(DUE_TIME);

    const response = await accept(
      apiClient().execute({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toMatchObject({ executed: 0, skipped: 1 });
    const mirror = await findMirrorTrigger(scheduleId);
    expect(mirror?.trigger.nextRunAt).toStrictEqual(dueDate());
    const runs = await findMirrorRuns(scheduleId);
    expect(runs).toHaveLength(0);
  });

  it("queues a triggered run when the org is at its concurrency limit", async () => {
    const fixture = await seedFixture([
      {
        name: "queued-cron",
        prompt: "Queued task",
        cronExpression: "0 9 * * *",
        nextRunAt: dueDate(),
      },
    ]);
    const scheduleId = fixture.scheduleIds[0]!;
    await mirrorSchedule(scheduleId);
    mockNow(DUE_TIME - 5 * 60 * 1000);
    await insertBlockingRun(fixture);
    mockNow(DUE_TIME);

    const response = await accept(
      apiClient().execute({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.executed).toBe(1);
    const runs = await findMirrorRuns(scheduleId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("queued");

    const mirror = await findMirrorTrigger(scheduleId);
    expect(mirror?.trigger.nextRunAt).toBeNull();
  });

  it("disables a queued one-time trigger after creating the run", async () => {
    const fixture = await seedFixture([
      {
        name: "queued-once",
        prompt: "Queued one-time task",
        atTime: dueDate(),
        nextRunAt: dueDate(),
      },
    ]);
    const scheduleId = fixture.scheduleIds[0]!;
    await mirrorSchedule(scheduleId);
    mockNow(DUE_TIME - 5 * 60 * 1000);
    await insertBlockingRun(fixture);
    mockNow(DUE_TIME);

    const response = await accept(
      apiClient().execute({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.executed).toBe(1);
    const runs = await findMirrorRuns(scheduleId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("queued");

    const mirror = await findMirrorTrigger(scheduleId);
    expect(mirror?.trigger.enabled).toBeFalsy();
    expect(mirror?.trigger.nextRunAt).toBeNull();
  });

  it("skips a due trigger while its previous run is still active", async () => {
    const fixture = await seedFixture([
      {
        name: "active-previous",
        prompt: "Active previous task",
        cronExpression: "0 9 * * *",
        nextRunAt: dueDate(),
      },
    ]);
    const scheduleId = fixture.scheduleIds[0]!;
    const activeRunId = await insertBlockingRun(fixture);
    const db = store.set(writeDb$);
    await db
      .update(zeroAgentSchedules)
      .set({ lastRunId: activeRunId })
      .where(eq(zeroAgentSchedules.id, scheduleId));
    await mirrorSchedule(scheduleId);
    mockNow(DUE_TIME);

    const response = await accept(
      apiClient().execute({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toMatchObject({ executed: 0, skipped: 1 });
    const mirror = await findMirrorTrigger(scheduleId);
    // Not claimed: next run unchanged.
    expect(mirror?.trigger.nextRunAt).toStrictEqual(dueDate());
    const runs = await findMirrorRuns(scheduleId);
    expect(runs).toHaveLength(0);
  });

  it("advances a cron trigger after a pre-run failure", async () => {
    const fixture = await seedFixture([
      {
        name: "cron-pre-run-failure",
        prompt: "Failure task",
        cronExpression: "0 9 * * *",
        nextRunAt: dueDate(),
      },
    ]);
    const scheduleId = fixture.scheduleIds[0]!;
    await mirrorSchedule(scheduleId);
    await clearComposeHeadVersion(fixture.composeId);
    mockNow(DUE_TIME);

    const response = await accept(
      apiClient().execute({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toMatchObject({ executed: 0, skipped: 1 });
    const mirror = await findMirrorTrigger(scheduleId);
    expect(mirror?.trigger.consecutiveFailures).toBe(1);
    expect(mirror?.trigger.enabled).toBeTruthy();
    expect(mirror?.trigger.nextRunAt?.getTime()).toBeGreaterThan(DUE_TIME);
  });

  it("advances a loop trigger after a pre-run failure", async () => {
    const fixture = await seedFixture([
      {
        name: "loop-pre-run-failure",
        prompt: "Loop failure task",
        intervalSeconds: 300,
        nextRunAt: dueDate(),
      },
    ]);
    const scheduleId = fixture.scheduleIds[0]!;
    await mirrorSchedule(scheduleId);
    await clearComposeHeadVersion(fixture.composeId);
    mockNow(DUE_TIME);

    await accept(apiClient().execute({ headers: cronHeaders() }), [200]);

    const mirror = await findMirrorTrigger(scheduleId);
    expect(mirror?.trigger.consecutiveFailures).toBe(1);
    expect(mirror?.trigger.enabled).toBeTruthy();
    expect(mirror?.trigger.nextRunAt).toStrictEqual(
      new Date(DUE_TIME + 300_000),
    );
  });

  it("auto-disables a trigger after three consecutive pre-run failures", async () => {
    const fixture = await seedFixture([
      {
        name: "auto-disable",
        prompt: "Auto-disable task",
        cronExpression: "0 9 * * *",
        nextRunAt: dueDate(),
        consecutiveFailures: 2,
      },
    ]);
    const scheduleId = fixture.scheduleIds[0]!;
    await mirrorSchedule(scheduleId);
    await clearComposeHeadVersion(fixture.composeId);
    mockNow(DUE_TIME);

    await accept(apiClient().execute({ headers: cronHeaders() }), [200]);

    const mirror = await findMirrorTrigger(scheduleId);
    expect(mirror?.trigger.consecutiveFailures).toBe(3);
    expect(mirror?.trigger.enabled).toBeFalsy();
    expect(mirror?.trigger.nextRunAt).toBeNull();
  });
});

// The schedule-table poller is dormant after the cutover (the cron route above
// polls automation_triggers); it stays in place as the revert path until the
// old table is dropped (phase 3). Direct coverage keeps its claim semantics
// and runtime mirror-sync honest in the meantime. Lives in this file so the
// two pollers' full-table scans never race across parallel test files.
describe("executeDueSchedules$ (dormant schedule-table poller)", () => {
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

  it("executes a due cron schedule and leaves advancement to the callback", async () => {
    const fixture = await seedFixture([
      {
        name: "dormant-due-cron",
        prompt: "Dormant daily task",
        cronExpression: "0 9 * * *",
        nextRunAt: dueDate(),
      },
    ]);
    const scheduleId = fixture.scheduleIds[0]!;
    mockNow(DUE_TIME);

    const result = await store.set(executeDueSchedules$, context.signal);

    expect(result.executed).toBe(1);
    const schedule = await findSchedule(scheduleId);
    expect(schedule?.enabled).toBeTruthy();
    expect(schedule?.lastRunAt).not.toBeNull();
    expect(schedule?.nextRunAt).toBeNull();
    expect(schedule?.lastRunId).not.toBeNull();
  });

  it("mirrors the claim and lastRunId onto the schedule's automation trigger", async () => {
    const fixture = await seedFixture([
      {
        name: "dormant-mirrored-cron",
        prompt: "Dormant mirrored task",
        cronExpression: "0 9 * * *",
        nextRunAt: dueDate(),
      },
    ]);
    const scheduleId = fixture.scheduleIds[0]!;
    await mirrorSchedule(scheduleId);
    mockNow(DUE_TIME);

    const result = await store.set(executeDueSchedules$, context.signal);

    expect(result.executed).toBe(1);
    const schedule = await findSchedule(scheduleId);
    const mirror = await findMirrorTrigger(scheduleId);
    expect(mirror?.trigger.nextRunAt).toBeNull();
    expect(mirror?.trigger.lastRunAt?.getTime()).toBe(
      schedule?.lastRunAt?.getTime(),
    );
    expect(schedule?.lastRunId).not.toBeNull();
    expect(mirror?.trigger.lastRunId).toBe(schedule?.lastRunId);
  });
});
