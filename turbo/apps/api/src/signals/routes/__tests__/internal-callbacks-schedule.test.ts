import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { seedAgentRunCallback$ } from "./helpers/agent-run-callback";
import { createFixtureTracker } from "./helpers/zero-route-test";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();

const CRON_PATH = "/api/internal/callbacks/schedule/cron";
const LOOP_PATH = "/api/internal/callbacks/schedule/loop";
const TEST_CALLBACK_SECRET = "test-callback-secret";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

interface ScheduleCallbackFixture extends UsageInsightFixture {
  readonly composeId: string;
}

type ScheduleKind = "cron" | "loop";

interface ScheduleSeedOptions {
  readonly kind: ScheduleKind;
  readonly enabled?: boolean;
  readonly consecutiveFailures?: number;
  readonly intervalSeconds?: number;
  readonly cronExpression?: string;
  readonly prompt?: string;
}

interface CallbackSeedOptions {
  readonly path: string;
  readonly scheduleId: string;
  readonly payload: Record<string, unknown>;
}

async function deleteFixture(fixture: ScheduleCallbackFixture): Promise<void> {
  await store.set(deleteUsageInsightFixture$, fixture, context.signal);
}

async function seedFixture(): Promise<ScheduleCallbackFixture> {
  const base = await store.set(
    seedUsageInsightFixture$,
    undefined,
    context.signal,
  );
  const { composeId } = await store.set(
    seedCompose$,
    {
      orgId: base.orgId,
      userId: base.userId,
      name: `schedule-callback-${randomUUID().slice(0, 8)}`,
    },
    context.signal,
  );
  return { ...base, composeId };
}

async function seedSchedule(
  fixture: ScheduleCallbackFixture,
  options: ScheduleSeedOptions,
): Promise<string> {
  const writeDb = store.set(writeDb$);
  const isCron = options.kind === "cron";
  const [row] = await writeDb
    .insert(zeroAgentSchedules)
    .values({
      agentId: fixture.composeId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      name: `schedule-${randomUUID().slice(0, 8)}`,
      triggerType: options.kind,
      cronExpression: isCron ? (options.cronExpression ?? "0 9 * * *") : null,
      intervalSeconds: isCron ? null : (options.intervalSeconds ?? 300),
      timezone: "UTC",
      prompt: options.prompt ?? `${options.kind} task`,
      enabled: options.enabled ?? true,
      consecutiveFailures: options.consecutiveFailures ?? 0,
    })
    .returning({ id: zeroAgentSchedules.id });
  if (!row) {
    throw new Error("seedSchedule: insert returned no row");
  }
  return row.id;
}

async function seedRunAndCallback(
  fixture: ScheduleCallbackFixture,
  options: CallbackSeedOptions,
): Promise<{ readonly runId: string; readonly callbackId: string }> {
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      composeId: fixture.composeId,
      triggerSource: "schedule",
      scheduleId: options.scheduleId,
      prompt: "Scheduled task",
    },
    context.signal,
  );
  const { callbackId } = await store.set(
    seedAgentRunCallback$,
    {
      runId,
      url: `http://localhost${options.path}`,
      payload: options.payload,
    },
    context.signal,
  );
  return { runId, callbackId };
}

function signedHeaders(rawBody: string): Record<string, string> {
  const timestamp = Math.floor(now() / 1000);
  return {
    "Content-Type": "application/json",
    "X-VM0-Signature": computeHmacSignature(
      rawBody,
      TEST_CALLBACK_SECRET,
      timestamp,
    ),
    "X-VM0-Timestamp": String(timestamp),
  };
}

async function postSignedCallback(
  path: string,
  body: Record<string, unknown>,
  invalidSignature = false,
): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const app = createApp({ signal: context.signal });
  return await app.request(path, {
    method: "POST",
    headers: invalidSignature
      ? {
          ...signedHeaders(rawBody),
          "X-VM0-Signature": "invalid-signature",
        }
      : signedHeaders(rawBody),
    body: rawBody,
  });
}

async function scheduleById(scheduleId: string) {
  const writeDb = store.set(writeDb$);
  const [row] = await writeDb
    .select()
    .from(zeroAgentSchedules)
    .where(eq(zeroAgentSchedules.id, scheduleId))
    .limit(1);
  return row;
}

async function updateSchedule(
  scheduleId: string,
  values: Partial<typeof zeroAgentSchedules.$inferInsert>,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .update(zeroAgentSchedules)
    .set(values)
    .where(eq(zeroAgentSchedules.id, scheduleId));
}

async function runSummary(runId: string): Promise<string | null> {
  const writeDb = store.set(writeDb$);
  const [row] = await writeDb
    .select({ summary: zeroRuns.summary })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return row?.summary ?? null;
}

afterEach(() => {
  vi.useRealTimers();
  clearMockNow();
  context.mocks.axiom.query.mockReset();
});

describe("POST /api/internal/callbacks/schedule/*", () => {
  const track = createFixtureTracker<ScheduleCallbackFixture>((fixture) => {
    return deleteFixture(fixture);
  });

  it("rejects cron callbacks with invalid signatures", async () => {
    const fixture = await track(seedFixture());
    const scheduleId = await seedSchedule(fixture, { kind: "cron" });
    const { runId } = await seedRunAndCallback(fixture, {
      path: CRON_PATH,
      scheduleId,
      payload: { scheduleId, cronExpression: "0 9 * * *", timezone: "UTC" },
    });

    const response = await postSignedCallback(
      CRON_PATH,
      {
        runId,
        status: "completed",
        payload: { scheduleId, cronExpression: "0 9 * * *", timezone: "UTC" },
      },
      true,
    );

    expect(response.status).toBe(401);
  });

  it("returns 404 when no loop callback record exists", async () => {
    const response = await postSignedCallback(LOOP_PATH, {
      runId: "00000000-0000-0000-0000-000000000000",
      status: "completed",
      payload: { scheduleId: "00000000-0000-0000-0000-000000000000" },
    });

    expect(response.status).toBe(404);
  });

  it("rejects invalid cron payloads", async () => {
    const fixture = await track(seedFixture());
    const scheduleId = await seedSchedule(fixture, { kind: "cron" });
    const { runId, callbackId } = await seedRunAndCallback(fixture, {
      path: CRON_PATH,
      scheduleId,
      payload: { scheduleId, cronExpression: "0 9 * * *", timezone: "UTC" },
    });

    const response = await postSignedCallback(CRON_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: { scheduleId },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Invalid or missing payload",
    });
  });

  it("skips loop progress callbacks without mutating schedules", async () => {
    const fixture = await track(seedFixture());
    const scheduleId = await seedSchedule(fixture, {
      kind: "loop",
      consecutiveFailures: 2,
    });
    const { runId, callbackId } = await seedRunAndCallback(fixture, {
      path: LOOP_PATH,
      scheduleId,
      payload: { scheduleId },
    });

    const response = await postSignedCallback(LOOP_PATH, {
      callbackId,
      runId,
      status: "progress",
      payload: { scheduleId },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      success: true,
      skipped: true,
    });
    const updated = await scheduleById(scheduleId);
    expect(updated?.consecutiveFailures).toBe(2);
    expect(updated?.enabled).toBeTruthy();
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
  });

  it("uses the current DB interval when completing loop callbacks", async () => {
    mockNow(new Date("2026-05-13T04:00:00.000Z"));
    const fixture = await track(seedFixture());
    const scheduleId = await seedSchedule(fixture, {
      kind: "loop",
      consecutiveFailures: 2,
      intervalSeconds: 300,
    });
    await updateSchedule(scheduleId, { intervalSeconds: 600 });
    const { runId, callbackId } = await seedRunAndCallback(fixture, {
      path: LOOP_PATH,
      scheduleId,
      payload: { scheduleId },
    });

    const response = await postSignedCallback(LOOP_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: { scheduleId },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    const updated = await scheduleById(scheduleId);
    expect(updated?.consecutiveFailures).toBe(0);
    expect(updated?.enabled).toBeTruthy();
    expect(updated?.nextRunAt?.toISOString()).toBe("2026-05-13T04:10:00.000Z");
  });

  it("advances cron callbacks and persists completed-run summaries", async () => {
    const completedAt = new Date("2026-05-13T04:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(completedAt);
    mockNow(completedAt);
    const fixture = await track(seedFixture());
    const scheduleId = await seedSchedule(fixture, {
      kind: "cron",
      consecutiveFailures: 2,
      prompt: "Daily report",
    });
    const { runId, callbackId } = await seedRunAndCallback(fixture, {
      path: CRON_PATH,
      scheduleId,
      payload: { scheduleId, cronExpression: "0 9 * * *", timezone: "UTC" },
    });
    context.mocks.axiom.query.mockResolvedValueOnce([
      {
        eventType: "result",
        eventData: { result: "Report completed." },
      },
    ]);
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    server.use(
      http.post(OPENROUTER_URL, () => {
        return HttpResponse.json({
          choices: [{ message: { content: "Schedule produced a report." } }],
        });
      }),
    );

    const response = await postSignedCallback(CRON_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: { scheduleId, cronExpression: "0 9 * * *", timezone: "UTC" },
    });

    expect(response.status).toBe(200);
    const updated = await scheduleById(scheduleId);
    expect(updated?.consecutiveFailures).toBe(0);
    expect(updated?.enabled).toBeTruthy();
    expect(updated?.nextRunAt?.toISOString()).toBe("2026-05-13T09:00:00.000Z");
    await expect(runSummary(runId)).resolves.toBe(
      "Schedule produced a report.",
    );
  });

  it("auto-disables cron schedules after the third consecutive failure", async () => {
    const fixture = await track(seedFixture());
    const scheduleId = await seedSchedule(fixture, {
      kind: "cron",
      consecutiveFailures: 2,
    });
    const { runId, callbackId } = await seedRunAndCallback(fixture, {
      path: CRON_PATH,
      scheduleId,
      payload: { scheduleId, cronExpression: "0 9 * * *", timezone: "UTC" },
    });

    const response = await postSignedCallback(CRON_PATH, {
      callbackId,
      runId,
      status: "failed",
      error: "Agent crashed",
      payload: { scheduleId, cronExpression: "0 9 * * *", timezone: "UTC" },
    });

    expect(response.status).toBe(200);
    const updated = await scheduleById(scheduleId);
    expect(updated?.consecutiveFailures).toBe(3);
    expect(updated?.enabled).toBeFalsy();
    expect(updated?.nextRunAt).toBeNull();
  });

  it("skips completed callbacks for disabled loop schedules", async () => {
    const fixture = await track(seedFixture());
    const scheduleId = await seedSchedule(fixture, {
      kind: "loop",
      enabled: false,
    });
    const { runId, callbackId } = await seedRunAndCallback(fixture, {
      path: LOOP_PATH,
      scheduleId,
      payload: { scheduleId },
    });

    const response = await postSignedCallback(LOOP_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: { scheduleId },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      success: true,
      skipped: true,
    });
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
  });
});
