import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { automations, automationTriggers } from "@vm0/db/schema/automation";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import { calculateNextRun } from "../../services/automations/time-trigger";
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

const CRON_PATH = "/api/internal/callbacks/trigger/cron";
const LOOP_PATH = "/api/internal/callbacks/trigger/loop";
const TEST_CALLBACK_SECRET = "test-callback-secret";

interface TriggerCallbackFixture extends UsageInsightFixture {
  readonly composeId: string;
}

type TriggerKind = "cron" | "loop";

interface TriggerSeedOptions {
  readonly kind: TriggerKind;
  readonly enabled?: boolean;
  readonly consecutiveFailures?: number;
  readonly intervalSeconds?: number;
  readonly cronExpression?: string;
}

interface CallbackSeedOptions {
  readonly path: string;
  readonly triggerId: string;
  readonly payload: Record<string, unknown>;
}

async function deleteFixture(fixture: TriggerCallbackFixture): Promise<void> {
  await store.set(deleteUsageInsightFixture$, fixture, context.signal);
}

async function seedFixture(): Promise<TriggerCallbackFixture> {
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
      name: `trigger-callback-${randomUUID().slice(0, 8)}`,
    },
    context.signal,
  );
  return { ...base, composeId };
}

// Seed an automation with one time trigger in the claimed state (next_run_at
// null) — what the row looks like while its run is in flight and the completion
// callback is pending.
async function seedTrigger(
  fixture: TriggerCallbackFixture,
  options: TriggerSeedOptions,
): Promise<string> {
  const writeDb = store.set(writeDb$);
  const isCron = options.kind === "cron";
  const [thread] = await writeDb
    .insert(chatThreads)
    .values({ userId: fixture.userId, agentComposeId: fixture.composeId })
    .returning({ id: chatThreads.id });
  if (!thread) {
    throw new Error("seedTrigger: chat thread insert returned no row");
  }
  const [automation] = await writeDb
    .insert(automations)
    .values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: `automation-${randomUUID().slice(0, 8)}`,
      instruction: `${options.kind} task`,
      agentId: fixture.composeId,
      chatThreadId: thread.id,
      interpreterKind: "time",
    })
    .returning({ id: automations.id });
  if (!automation) {
    throw new Error("seedTrigger: automation insert returned no row");
  }
  const [row] = await writeDb
    .insert(automationTriggers)
    .values({
      automationId: automation.id,
      kind: options.kind,
      cronExpression: isCron ? (options.cronExpression ?? "0 9 * * *") : null,
      intervalSeconds: isCron ? null : (options.intervalSeconds ?? 300),
      timezone: "UTC",
      nextRunAt: null,
      enabled: options.enabled ?? true,
      consecutiveFailures: options.consecutiveFailures ?? 0,
    })
    .returning({ id: automationTriggers.id });
  if (!row) {
    throw new Error("seedTrigger: trigger insert returned no row");
  }
  return row.id;
}

async function seedRunAndCallback(
  fixture: TriggerCallbackFixture,
  options: CallbackSeedOptions,
): Promise<{ readonly runId: string; readonly callbackId: string }> {
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      composeId: fixture.composeId,
      triggerSource: "automation",
      prompt: "Triggered task",
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

async function triggerById(triggerId: string) {
  const writeDb = store.set(writeDb$);
  const [row] = await writeDb
    .select()
    .from(automationTriggers)
    .where(eq(automationTriggers.id, triggerId))
    .limit(1);
  return row;
}

async function updateTrigger(
  triggerId: string,
  values: Partial<typeof automationTriggers.$inferInsert>,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .update(automationTriggers)
    .set(values)
    .where(eq(automationTriggers.id, triggerId));
}

async function deleteTrigger(triggerId: string): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .delete(automationTriggers)
    .where(eq(automationTriggers.id, triggerId));
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
  clearMockNow();
});

describe("POST /api/internal/callbacks/trigger/*", () => {
  const track = createFixtureTracker<TriggerCallbackFixture>((fixture) => {
    return deleteFixture(fixture);
  });

  it("rejects cron callbacks with invalid signatures", async () => {
    const fixture = await track(seedFixture());
    const triggerId = await seedTrigger(fixture, { kind: "cron" });
    const { runId } = await seedRunAndCallback(fixture, {
      path: CRON_PATH,
      triggerId,
      payload: { triggerId, cronExpression: "0 9 * * *", timezone: "UTC" },
    });

    const response = await postSignedCallback(
      CRON_PATH,
      {
        runId,
        status: "completed",
        payload: { triggerId, cronExpression: "0 9 * * *", timezone: "UTC" },
      },
      true,
    );

    expect(response.status).toBe(401);
  });

  it("rejects invalid cron payloads", async () => {
    const fixture = await track(seedFixture());
    const triggerId = await seedTrigger(fixture, { kind: "cron" });
    const { runId, callbackId } = await seedRunAndCallback(fixture, {
      path: CRON_PATH,
      triggerId,
      payload: { triggerId, cronExpression: "0 9 * * *", timezone: "UTC" },
    });

    const response = await postSignedCallback(CRON_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: { triggerId },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Invalid or missing payload",
    });
  });

  it("rejects invalid loop payloads", async () => {
    const fixture = await track(seedFixture());
    const triggerId = await seedTrigger(fixture, { kind: "loop" });
    const { runId, callbackId } = await seedRunAndCallback(fixture, {
      path: LOOP_PATH,
      triggerId,
      payload: { triggerId },
    });

    const response = await postSignedCallback(LOOP_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: {},
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Invalid or missing payload",
    });
  });

  it("skips progress callbacks without mutating triggers", async () => {
    const fixture = await track(seedFixture());
    const triggerId = await seedTrigger(fixture, {
      kind: "loop",
      consecutiveFailures: 2,
    });
    const { runId, callbackId } = await seedRunAndCallback(fixture, {
      path: LOOP_PATH,
      triggerId,
      payload: { triggerId },
    });

    const response = await postSignedCallback(LOOP_PATH, {
      callbackId,
      runId,
      status: "progress",
      payload: { triggerId },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      success: true,
      skipped: true,
    });
    const updated = await triggerById(triggerId);
    expect(updated?.consecutiveFailures).toBe(2);
    expect(updated?.enabled).toBeTruthy();
    expect(updated?.nextRunAt).toBeNull();
  });

  it("uses the current DB interval when completing loop callbacks", async () => {
    mockNow(new Date("2026-05-13T04:00:00.000Z"));
    const fixture = await track(seedFixture());
    const triggerId = await seedTrigger(fixture, {
      kind: "loop",
      consecutiveFailures: 2,
      intervalSeconds: 300,
    });
    await updateTrigger(triggerId, { intervalSeconds: 600 });
    const { runId, callbackId } = await seedRunAndCallback(fixture, {
      path: LOOP_PATH,
      triggerId,
      payload: { triggerId },
    });

    const response = await postSignedCallback(LOOP_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: { triggerId },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    const updated = await triggerById(triggerId);
    expect(updated?.consecutiveFailures).toBe(0);
    expect(updated?.enabled).toBeTruthy();
    expect(updated?.nextRunAt?.toISOString()).toBe("2026-05-13T04:10:00.000Z");
    // The chat callback owns the run summary; the reschedule callback must not
    // write one.
    await expect(runSummary(runId)).resolves.toBeNull();
  });

  it("increments loop failure counters before the auto-disable threshold", async () => {
    const failedAt = new Date("2026-05-13T04:00:00.000Z");
    mockNow(failedAt);
    const fixture = await track(seedFixture());
    const triggerId = await seedTrigger(fixture, { kind: "loop" });
    const { runId, callbackId } = await seedRunAndCallback(fixture, {
      path: LOOP_PATH,
      triggerId,
      payload: { triggerId },
    });

    const response = await postSignedCallback(LOOP_PATH, {
      callbackId,
      runId,
      status: "failed",
      error: "Agent crashed",
      payload: { triggerId },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    const updated = await triggerById(triggerId);
    expect(updated?.consecutiveFailures).toBe(1);
    expect(updated?.enabled).toBeTruthy();
    expect(updated?.nextRunAt?.toISOString()).toBe("2026-05-13T04:05:00.000Z");
  });

  it("auto-disables loop triggers after the third consecutive failure", async () => {
    const fixture = await track(seedFixture());
    const triggerId = await seedTrigger(fixture, {
      kind: "loop",
      consecutiveFailures: 2,
    });
    const { runId, callbackId } = await seedRunAndCallback(fixture, {
      path: LOOP_PATH,
      triggerId,
      payload: { triggerId },
    });

    const response = await postSignedCallback(LOOP_PATH, {
      callbackId,
      runId,
      status: "failed",
      error: "Agent crashed",
      payload: { triggerId },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    const updated = await triggerById(triggerId);
    expect(updated?.consecutiveFailures).toBe(3);
    expect(updated?.enabled).toBeFalsy();
    expect(updated?.nextRunAt).toBeNull();
  });

  it("advances cron callbacks from the dispatched expression on completion", async () => {
    const completedAt = new Date("2026-05-13T04:00:00.000Z");
    mockNow(completedAt);
    const fixture = await track(seedFixture());
    const triggerId = await seedTrigger(fixture, {
      kind: "cron",
      consecutiveFailures: 2,
    });
    const { runId, callbackId } = await seedRunAndCallback(fixture, {
      path: CRON_PATH,
      triggerId,
      payload: { triggerId, cronExpression: "0 9 * * *", timezone: "UTC" },
    });

    const response = await postSignedCallback(CRON_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: { triggerId, cronExpression: "0 9 * * *", timezone: "UTC" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    const updated = await triggerById(triggerId);
    expect(updated?.consecutiveFailures).toBe(0);
    expect(updated?.enabled).toBeTruthy();
    expect(updated?.nextRunAt?.toISOString()).toBe(
      calculateNextRun("0 9 * * *", "UTC", completedAt)?.toISOString(),
    );
    await expect(runSummary(runId)).resolves.toBeNull();
  });

  it("increments cron failure counters before the auto-disable threshold", async () => {
    const failedAt = new Date("2026-05-13T04:00:00.000Z");
    mockNow(failedAt);
    const fixture = await track(seedFixture());
    const triggerId = await seedTrigger(fixture, { kind: "cron" });
    const { runId, callbackId } = await seedRunAndCallback(fixture, {
      path: CRON_PATH,
      triggerId,
      payload: { triggerId, cronExpression: "0 9 * * *", timezone: "UTC" },
    });

    const response = await postSignedCallback(CRON_PATH, {
      callbackId,
      runId,
      status: "failed",
      error: "Agent crashed",
      payload: { triggerId, cronExpression: "0 9 * * *", timezone: "UTC" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    const updated = await triggerById(triggerId);
    expect(updated?.consecutiveFailures).toBe(1);
    expect(updated?.enabled).toBeTruthy();
    expect(updated?.nextRunAt?.toISOString()).toBe(
      calculateNextRun("0 9 * * *", "UTC", failedAt)?.toISOString(),
    );
  });

  it("auto-disables cron triggers after the third consecutive failure", async () => {
    const fixture = await track(seedFixture());
    const triggerId = await seedTrigger(fixture, {
      kind: "cron",
      consecutiveFailures: 2,
    });
    const { runId, callbackId } = await seedRunAndCallback(fixture, {
      path: CRON_PATH,
      triggerId,
      payload: { triggerId, cronExpression: "0 9 * * *", timezone: "UTC" },
    });

    const response = await postSignedCallback(CRON_PATH, {
      callbackId,
      runId,
      status: "failed",
      error: "Agent crashed",
      payload: { triggerId, cronExpression: "0 9 * * *", timezone: "UTC" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    const updated = await triggerById(triggerId);
    expect(updated?.consecutiveFailures).toBe(3);
    expect(updated?.enabled).toBeFalsy();
    expect(updated?.nextRunAt).toBeNull();
  });

  it("skips completed callbacks for deleted triggers", async () => {
    const fixture = await track(seedFixture());
    const triggerId = await seedTrigger(fixture, { kind: "cron" });
    const { runId, callbackId } = await seedRunAndCallback(fixture, {
      path: CRON_PATH,
      triggerId,
      payload: { triggerId, cronExpression: "0 9 * * *", timezone: "UTC" },
    });
    await deleteTrigger(triggerId);

    const response = await postSignedCallback(CRON_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: { triggerId, cronExpression: "0 9 * * *", timezone: "UTC" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      success: true,
      skipped: true,
    });
  });

  it("skips completed callbacks for disabled triggers (once after claim)", async () => {
    const fixture = await track(seedFixture());
    // A once trigger is disabled at claim time, so its completion callback must
    // land in the disabled-skip branch — live schedule parity.
    const triggerId = await seedTrigger(fixture, {
      kind: "cron",
      enabled: false,
    });
    const { runId, callbackId } = await seedRunAndCallback(fixture, {
      path: CRON_PATH,
      triggerId,
      payload: { triggerId, timezone: "UTC" },
    });

    const response = await postSignedCallback(CRON_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: { triggerId, timezone: "UTC" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      success: true,
      skipped: true,
    });
    const updated = await triggerById(triggerId);
    expect(updated?.enabled).toBeFalsy();
    expect(updated?.consecutiveFailures).toBe(0);
  });
});
