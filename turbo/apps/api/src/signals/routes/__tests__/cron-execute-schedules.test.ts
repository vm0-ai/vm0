import { randomUUID } from "node:crypto";

import { cronExecuteSchedulesContract } from "@vm0/api-contracts/contracts/cron";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { createStore } from "ccstate";
import { desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, nowDate } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
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

async function findSchedule(scheduleId: string) {
  const db = store.set(writeDb$);
  const [schedule] = await db
    .select()
    .from(zeroAgentSchedules)
    .where(eq(zeroAgentSchedules.id, scheduleId));
  return schedule;
}

async function findScheduleRuns(scheduleId: string) {
  const db = store.set(writeDb$);
  return await db
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      prompt: agentRuns.prompt,
      appendSystemPrompt: agentRuns.appendSystemPrompt,
    })
    .from(agentRuns)
    .innerJoin(zeroRuns, eq(agentRuns.id, zeroRuns.id))
    .where(eq(zeroRuns.scheduleId, scheduleId))
    .orderBy(desc(agentRuns.createdAt));
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

describe("GET /api/cron/execute-schedules", () => {
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

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns execution counts when no schedules are due", async () => {
    await seedFixture([
      {
        name: "future-cron",
        prompt: "Future task",
        cronExpression: "0 9 * * *",
        nextRunAt: new Date("2000-01-02T09:00:00.000Z"),
      },
    ]);
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

  it("executes a due cron schedule and leaves cron advancement to the callback", async () => {
    const fixture = await seedFixture([
      {
        name: "due-cron",
        prompt: "Daily task",
        cronExpression: "0 9 * * *",
        nextRunAt: dueDate(),
      },
    ]);
    const scheduleId = fixture.scheduleIds[0]!;
    mockNow(DUE_TIME);

    const response = await accept(
      apiClient().execute({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.executed).toBe(1);
    const schedule = await findSchedule(scheduleId);
    expect(schedule?.enabled).toBeTruthy();
    expect(schedule?.lastRunAt).not.toBeNull();
    expect(schedule?.nextRunAt).toBeNull();

    const runs = await findScheduleRuns(scheduleId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.prompt).toBe("Daily task");
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
    mockNow(DUE_TIME);

    const [first, second] = await Promise.all([
      accept(apiClient().execute({ headers: cronHeaders() }), [200]),
      accept(apiClient().execute({ headers: cronHeaders() }), [200]),
    ]);

    expect(first.body.executed + second.body.executed).toBe(1);
    const runs = await findScheduleRuns(scheduleId);
    expect(runs).toHaveLength(1);
  });

  it("executes and disables a due one-time schedule", async () => {
    const fixture = await seedFixture([
      {
        name: "due-once",
        prompt: "One-time task",
        atTime: dueDate(),
        nextRunAt: dueDate(),
      },
    ]);
    const scheduleId = fixture.scheduleIds[0]!;
    mockNow(DUE_TIME);

    const response = await accept(
      apiClient().execute({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.executed).toBe(1);
    const schedule = await findSchedule(scheduleId);
    expect(schedule?.enabled).toBeFalsy();
    expect(schedule?.nextRunAt).toBeNull();
    expect(schedule?.lastRunAt).not.toBeNull();
  });

  it("passes appendSystemPrompt from the schedule to the created run", async () => {
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
    mockNow(DUE_TIME);

    await accept(apiClient().execute({ headers: cronHeaders() }), [200]);

    const runs = await findScheduleRuns(scheduleId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.appendSystemPrompt).toContain(
      "# Current Integration\nYou are currently running inside: Schedule",
    );
    expect(runs[0]?.appendSystemPrompt).toContain("Trigger type: cron");
    expect(runs[0]?.appendSystemPrompt).toContain(
      "Always respond in formal tone",
    );
  });

  it("executes a due loop schedule and waits for the callback to set the next run", async () => {
    const fixture = await seedFixture([
      {
        name: "due-loop",
        prompt: "Loop task",
        intervalSeconds: 300,
        nextRunAt: dueDate(),
      },
    ]);
    const scheduleId = fixture.scheduleIds[0]!;
    mockNow(DUE_TIME);

    const response = await accept(
      apiClient().execute({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.executed).toBe(1);
    const schedule = await findSchedule(scheduleId);
    expect(schedule?.enabled).toBeTruthy();
    expect(schedule?.lastRunAt).not.toBeNull();
    expect(schedule?.nextRunAt).toBeNull();
  });

  it("queues a scheduled run when the org is at its concurrency limit", async () => {
    const fixture = await seedFixture([
      {
        name: "queued-cron",
        prompt: "Queued task",
        cronExpression: "0 9 * * *",
        nextRunAt: dueDate(),
      },
    ]);
    const scheduleId = fixture.scheduleIds[0]!;
    mockNow(DUE_TIME - 5 * 60 * 1000);
    await insertBlockingRun(fixture);
    mockNow(DUE_TIME);

    const response = await accept(
      apiClient().execute({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.executed).toBe(1);
    const runs = await findScheduleRuns(scheduleId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("queued");

    const schedule = await findSchedule(scheduleId);
    expect(schedule?.retryStartedAt).toBeNull();
    expect(schedule?.nextRunAt).toBeNull();
  });

  it("skips a due schedule while its previous run is still active", async () => {
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
    mockNow(DUE_TIME);

    const response = await accept(
      apiClient().execute({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toMatchObject({ executed: 0, skipped: 1 });
    const schedule = await findSchedule(scheduleId);
    expect(schedule?.nextRunAt).toStrictEqual(dueDate());
    const runs = await findScheduleRuns(scheduleId);
    expect(runs).toHaveLength(0);
  });

  it("advances a cron schedule after a pre-run failure", async () => {
    const fixture = await seedFixture([
      {
        name: "cron-pre-run-failure",
        prompt: "Failure task",
        cronExpression: "0 9 * * *",
        nextRunAt: dueDate(),
      },
    ]);
    const scheduleId = fixture.scheduleIds[0]!;
    await clearComposeHeadVersion(fixture.composeId);
    mockNow(DUE_TIME);

    const response = await accept(
      apiClient().execute({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toMatchObject({ executed: 0, skipped: 1 });
    const schedule = await findSchedule(scheduleId);
    expect(schedule?.consecutiveFailures).toBe(1);
    expect(schedule?.enabled).toBeTruthy();
    expect(schedule?.nextRunAt?.getTime()).toBeGreaterThan(DUE_TIME);
  });

  it("advances a loop schedule after a pre-run failure", async () => {
    const fixture = await seedFixture([
      {
        name: "loop-pre-run-failure",
        prompt: "Loop failure task",
        intervalSeconds: 300,
        nextRunAt: dueDate(),
      },
    ]);
    const scheduleId = fixture.scheduleIds[0]!;
    await clearComposeHeadVersion(fixture.composeId);
    mockNow(DUE_TIME);

    await accept(apiClient().execute({ headers: cronHeaders() }), [200]);

    const schedule = await findSchedule(scheduleId);
    expect(schedule?.consecutiveFailures).toBe(1);
    expect(schedule?.enabled).toBeTruthy();
    expect(schedule?.nextRunAt).toStrictEqual(new Date(DUE_TIME + 300_000));
  });

  it("auto-disables a schedule after three consecutive pre-run failures", async () => {
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
    await clearComposeHeadVersion(fixture.composeId);
    mockNow(DUE_TIME);

    await accept(apiClient().execute({ headers: cronHeaders() }), [200]);

    const schedule = await findSchedule(scheduleId);
    expect(schedule?.consecutiveFailures).toBe(3);
    expect(schedule?.enabled).toBeFalsy();
    expect(schedule?.nextRunAt).toBeNull();
  });
});
