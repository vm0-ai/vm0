import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { cronCompactUsageEventsContract } from "@vm0/api-contracts/contracts/cron";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import {
  attachUsageAllowance$,
  deleteUsageData$,
  deleteUsageInsightFixture$,
  deleteRun$,
  holdUsageCompactionLock$,
  insertUsageEvent$,
  materializeHourlyUsage$,
  readAllowanceWindowState$,
  readUsageCompactionLockState$,
  readUsageStorageCounts$,
  releaseUsageCompactionLock$,
  seedChatThread$,
  seedCompose$,
  seedRun$,
  seedUsageOverflowGrain$,
  seedUsageInsightFixture$,
  setBrowserUsageHold$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();
const CRON_SECRET = "test-compact-usage-events-secret";

function cronClient() {
  return setupApp({ context })(cronCompactUsageEventsContract);
}

function cronHeaders(secret = CRON_SECRET) {
  return { authorization: `Bearer ${secret}` };
}

async function seedFixture(): Promise<UsageInsightFixture> {
  const fixture = await store.set(
    seedUsageInsightFixture$,
    undefined,
    context.signal,
  );
  onTestFinished(async () => {
    await store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });
  return fixture;
}

async function compactUsage() {
  return await accept(cronClient().compact({ headers: cronHeaders() }), [200]);
}

async function readStorage(fixture: UsageInsightFixture) {
  return await store.set(
    readUsageStorageCounts$,
    { scope: "organization", id: fixture.orgId },
    context.signal,
  );
}

async function seedCompactionAnchor(
  processedAt: Date,
  quantity: number,
): Promise<void> {
  const fixture = await seedFixture();
  await store.set(
    insertUsageEvent$,
    {
      ...fixture,
      status: "processed",
      quantity,
      processedAt,
    },
    context.signal,
  );
}

async function startUsageCompactionLockGate(): Promise<{
  readonly gateId: string;
  readonly holder: Promise<void>;
}> {
  const gateId = randomUUID();
  const holder = createStore().set(
    holdUsageCompactionLock$,
    gateId,
    context.signal,
  );
  onTestFinished(async () => {
    await createStore().set(
      releaseUsageCompactionLock$,
      gateId,
      context.signal,
    );
    await holder;
  });
  await expect
    .poll(async () => {
      const state = await createStore().set(
        readUsageCompactionLockState$,
        gateId,
        context.signal,
      );
      return state.held;
    })
    .toBe(true);
  return { gateId, holder };
}

async function waitForUsageCompactionLockWaiters(
  gateId: string,
  minimum: number,
): Promise<void> {
  await expect
    .poll(async () => {
      const state = await createStore().set(
        readUsageCompactionLockState$,
        gateId,
        context.signal,
      );
      return state.waiterCount;
    })
    .toBeGreaterThanOrEqual(minimum);
}

async function releaseUsageCompactionLockGate(args: {
  readonly gateId: string;
  readonly holder: Promise<void>;
}): Promise<void> {
  await createStore().set(
    releaseUsageCompactionLock$,
    args.gateId,
    context.signal,
  );
  await args.holder;
}

async function seedRunContext(fixture: UsageInsightFixture): Promise<{
  readonly runId: string;
  readonly chatThreadId: string;
}> {
  const compose = await store.set(seedCompose$, fixture, context.signal);
  const chatThreadId = await store.set(
    seedChatThread$,
    {
      userId: fixture.userId,
      composeId: compose.composeId,
      title: "Compaction browser fixture",
    },
    context.signal,
  );
  const run = await store.set(
    seedRun$,
    {
      ...fixture,
      composeId: compose.composeId,
      chatThreadId,
      status: "completed",
      createdAt: new Date("0500-01-01T00:00:00.000Z"),
      completedAt: new Date("0500-01-01T00:01:00.000Z"),
    },
    context.signal,
  );
  return { runId: run.runId, chatThreadId };
}

describe("usage event compaction cron", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", CRON_SECRET);
    mockOptionalEnv("USAGE_EVENT_COMPACTION_BATCH_SIZE", "1");
  });

  it("requires the cron secret", async () => {
    const response = await accept(cronClient().compact({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "Invalid cron secret" },
    });
  });

  it("atomically replaces an old processed grain", async () => {
    const fixture = await seedFixture();
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        runId: null,
        status: "processed",
        quantity: 3,
        creditsCharged: 7,
        processedAt: new Date("1800-01-01T00:15:00.000Z"),
      },
      context.signal,
    );

    const response = await compactUsage();

    expect(response.body).toMatchObject({
      success: true,
      batchSize: 1,
      selectedGrains: 1,
      rawRowsDeleted: 1,
      hourlyRowsDeleted: 0,
      hourlyRowsInserted: 1,
      quantity: "3",
      creditsCharged: "7",
      allowanceUnits: "0",
      reconciled: true,
    });
    expect(Object.keys(response.body).sort()).toStrictEqual([
      "affectedShortWindows",
      "affectedWeeklyWindows",
      "allowanceUnits",
      "batchSize",
      "billingErrorHeldRows",
      "browserHeldRows",
      "candidateGrains",
      "creditsCharged",
      "cutoff",
      "duplicateHourlyRowsDeleted",
      "durationMs",
      "hasMore",
      "hourlyRowsDeleted",
      "hourlyRowsInserted",
      "lockWaitMs",
      "probedRawRows",
      "quantity",
      "rawRowsDeleted",
      "reconciled",
      "selectedGrains",
      "success",
    ]);
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 0,
      hourly: 1,
    });
  });

  it("retains unstable hours and explicit diagnostic holds", async () => {
    const fixture = await seedFixture();
    const currentHour = nowDate();
    currentHour.setUTCMinutes(0, 0, 0);
    const previousHour = new Date(currentHour.getTime() - 60 * 60 * 1000);

    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "processed",
        processedAt: new Date("0399-01-01T00:15:00.000Z"),
        billingError: "missing_pricing",
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "pending",
        processedAt: new Date("0400-01-01T00:15:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "processed",
        processedAt: previousHour,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "processed",
        processedAt: new Date(currentHour.getTime() + 1000),
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "processed",
        processedAt: new Date("0400-01-01T00:30:00.000Z"),
      },
      context.signal,
    );

    const response = await compactUsage();

    expect(response.body).toMatchObject({
      rawRowsDeleted: 1,
      hourlyRowsInserted: 1,
      billingErrorHeldRows: 1,
    });
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 4,
      hourly: 1,
    });
  });

  it("protects the browser pre-reference crash window until settlement", async () => {
    const fixture = await seedFixture();
    const run = await seedRunContext(fixture);
    const idempotencyKey = randomUUID();
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        runId: run.runId,
        idempotencyKey,
        status: "processed",
        processedAt: new Date("0300-01-01T00:15:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      setBrowserUsageHold$,
      {
        ...fixture,
        ...run,
        idempotencyKey,
        settled: false,
      },
      context.signal,
    );
    await seedCompactionAnchor(new Date("0300-01-01T01:15:00.000Z"), 30_001);

    const held = await compactUsage();
    expect(held.body).toMatchObject({
      browserHeldRows: 1,
      rawRowsDeleted: 1,
      quantity: "30001",
    });
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 1,
      hourly: 0,
    });

    await store.set(
      setBrowserUsageHold$,
      {
        ...fixture,
        ...run,
        idempotencyKey,
        settled: true,
      },
      context.signal,
    );
    const released = await compactUsage();
    expect(released.body).toMatchObject({
      rawRowsDeleted: 1,
      hourlyRowsInserted: 1,
    });
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 0,
      hourly: 1,
    });
  });

  it("expands a bounded seed to the complete physical grain", async () => {
    const fixture = await seedFixture();
    for (let index = 0; index < 3; index += 1) {
      await store.set(
        insertUsageEvent$,
        {
          ...fixture,
          status: "processed",
          quantity: index + 1,
          processedAt: new Date("0200-01-01T00:15:00.000Z"),
        },
        context.signal,
      );
    }
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "processed",
        category: "different-grain",
        processedAt: new Date("0200-01-01T01:15:00.000Z"),
      },
      context.signal,
    );

    const response = await compactUsage();

    expect(response.body).toMatchObject({
      batchSize: 1,
      selectedGrains: 1,
      rawRowsDeleted: 3,
      hourlyRowsInserted: 1,
      quantity: "6",
      hasMore: true,
    });
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 1,
      hourly: 1,
    });
  });

  it("repairs duplicate hourly rows and reconsolidates late data", async () => {
    const fixture = await seedFixture();
    for (const quantity of [2, 3]) {
      await store.set(
        insertUsageEvent$,
        {
          ...fixture,
          status: "processed",
          quantity,
          creditsCharged: quantity,
          processedAt: new Date("0100-01-01T00:15:00.000Z"),
        },
        context.signal,
      );
    }
    await expect(
      store.set(
        materializeHourlyUsage$,
        { ...fixture, runId: null },
        context.signal,
      ),
    ).resolves.toBe(2);

    const repaired = await compactUsage();
    expect(repaired.body).toMatchObject({
      rawRowsDeleted: 0,
      hourlyRowsDeleted: 2,
      duplicateHourlyRowsDeleted: 1,
      hourlyRowsInserted: 1,
      quantity: "5",
      creditsCharged: "5",
    });

    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "processed",
        quantity: 7,
        creditsCharged: 11,
        processedAt: new Date("0100-01-01T00:45:00.000Z"),
      },
      context.signal,
    );
    const late = await compactUsage();
    expect(late.body).toMatchObject({
      rawRowsDeleted: 1,
      hourlyRowsDeleted: 1,
      hourlyRowsInserted: 1,
      quantity: "12",
      creditsCharged: "16",
    });
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 0,
      hourly: 1,
    });

    await seedCompactionAnchor(new Date("0100-01-01T01:15:00.000Z"), 10_001);
    const retry = await compactUsage();
    expect(retry.body).toMatchObject({
      rawRowsDeleted: 1,
      quantity: "10001",
    });
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 0,
      hourly: 1,
    });
  });

  it("preserves distinct allowance window pairs and consumed units", async () => {
    mockOptionalEnv("USAGE_EVENT_COMPACTION_BATCH_SIZE", "3");
    const fixture = await seedFixture();
    const firstEventId = await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "processed",
        quantity: 2,
        creditsCharged: 3,
        processedAt: new Date("0900-01-01T00:15:00.000Z"),
      },
      context.signal,
    );
    const firstPair = await store.set(
      attachUsageAllowance$,
      {
        orgId: fixture.orgId,
        runId: null,
        usageEventId: firstEventId,
        unitsApplied: 5,
        consumedUnits: 11,
      },
      context.signal,
    );
    const secondEventId = await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "processed",
        quantity: 4,
        creditsCharged: 6,
        processedAt: new Date("0900-01-01T00:30:00.000Z"),
      },
      context.signal,
    );
    const secondPair = await store.set(
      attachUsageAllowance$,
      {
        orgId: fixture.orgId,
        runId: null,
        usageEventId: secondEventId,
        unitsApplied: 7,
        consumedUnits: 22,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "processed",
        quantity: 8,
        creditsCharged: 9,
        processedAt: new Date("0900-01-01T00:45:00.000Z"),
      },
      context.signal,
    );

    const response = await compactUsage();

    expect(response.body).toMatchObject({
      selectedGrains: 3,
      rawRowsDeleted: 3,
      hourlyRowsInserted: 3,
      quantity: "14",
      creditsCharged: "18",
      allowanceUnits: "12",
      affectedShortWindows: 2,
      affectedWeeklyWindows: 2,
      reconciled: true,
    });
    await expect(
      store.set(readAllowanceWindowState$, firstPair, context.signal),
    ).resolves.toStrictEqual({
      shortWindowConsumedUnits: "11",
      weeklyWindowConsumedUnits: "11",
      rawAllowanceUnits: "0",
      hourlyAllowanceUnits: "5",
      allocationCount: 0,
    });
    await expect(
      store.set(readAllowanceWindowState$, secondPair, context.signal),
    ).resolves.toStrictEqual({
      shortWindowConsumedUnits: "22",
      weeklyWindowConsumedUnits: "22",
      rawAllowanceUnits: "0",
      hourlyAllowanceUnits: "7",
      allocationCount: 0,
    });
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 0,
      hourly: 3,
    });
  });

  it("reconsolidates facts after run deletion makes their run IDs null", async () => {
    const fixture = await seedFixture();
    const run = await seedRunContext(fixture);
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        runId: run.runId,
        status: "processed",
        quantity: 2,
        processedAt: new Date("0800-01-01T00:15:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      materializeHourlyUsage$,
      { ...fixture, runId: run.runId },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        runId: run.runId,
        status: "processed",
        quantity: 3,
        processedAt: new Date("0800-01-01T00:30:00.000Z"),
      },
      context.signal,
    );

    await store.set(deleteRun$, run.runId, context.signal);
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 1,
      hourly: 1,
    });
    const response = await compactUsage();

    expect(response.body).toMatchObject({
      rawRowsDeleted: 1,
      hourlyRowsDeleted: 1,
      hourlyRowsInserted: 1,
      quantity: "5",
    });
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 0,
      hourly: 1,
    });
  });

  it("serializes overlapping invocations without duplicating facts", async () => {
    const fixture = await seedFixture();
    for (let index = 0; index < 10; index += 1) {
      await store.set(
        insertUsageEvent$,
        {
          ...fixture,
          status: "processed",
          processedAt: new Date("0700-01-01T00:15:00.000Z"),
        },
        context.signal,
      );
    }
    await seedCompactionAnchor(new Date("0700-01-01T01:15:00.000Z"), 70_001);

    const responses = await Promise.all([compactUsage(), compactUsage()]);

    const outcomes = responses.map((response) => {
      return {
        rawRowsDeleted: response.body.rawRowsDeleted,
        quantity: response.body.quantity,
      };
    });
    expect(outcomes).toHaveLength(2);
    expect(outcomes).toStrictEqual(
      expect.arrayContaining([
        { rawRowsDeleted: 10, quantity: "10" },
        { rawRowsDeleted: 1, quantity: "70001" },
      ]),
    );
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 0,
      hourly: 1,
    });
  });

  it("lets organization cleanup remove a batch compacted ahead of it", async () => {
    const fixture = await seedFixture();
    const quantity = 8_000_000_000_000_123;
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "processed",
        quantity,
        processedAt: new Date("0001-01-01T00:15:00.000Z"),
      },
      context.signal,
    );
    const gate = await startUsageCompactionLockGate();

    const compaction = compactUsage();
    await waitForUsageCompactionLockWaiters(gate.gateId, 1);
    const cleanup = createStore().set(
      deleteUsageData$,
      { scope: "organization", id: fixture.orgId },
      context.signal,
    );
    await waitForUsageCompactionLockWaiters(gate.gateId, 2);
    await releaseUsageCompactionLockGate(gate);
    const [response] = await Promise.all([compaction, cleanup]);

    expect(response.body).toMatchObject({
      rawRowsDeleted: 1,
      hourlyRowsInserted: 1,
      quantity: String(quantity),
    });
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 0,
      hourly: 0,
    });
  });

  it("keeps compaction from reviving usage deleted ahead of it", async () => {
    const fixture = await seedFixture();
    const quantity = 7_000_000_000_000_321;
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "processed",
        quantity,
        processedAt: new Date("0001-01-01T00:15:00.000Z"),
      },
      context.signal,
    );
    await seedCompactionAnchor(new Date("0001-01-01T01:15:00.000Z"), 1001);
    const gate = await startUsageCompactionLockGate();

    const cleanup = createStore().set(
      deleteUsageData$,
      { scope: "user", id: fixture.userId },
      context.signal,
    );
    await waitForUsageCompactionLockWaiters(gate.gateId, 1);
    const compaction = compactUsage();
    await waitForUsageCompactionLockWaiters(gate.gateId, 2);
    await releaseUsageCompactionLockGate(gate);
    const [, response] = await Promise.all([cleanup, compaction]);

    expect(response.body).toMatchObject({
      rawRowsDeleted: 1,
      quantity: "1001",
    });
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 0,
      hourly: 0,
    });
  });

  it("rolls back replacement and source deletion when the aggregate overflows bigint", async () => {
    const fixture = await seedFixture();
    await store.set(
      seedUsageOverflowGrain$,
      {
        ...fixture,
        processedAt: new Date("0600-01-01T00:15:00.000Z"),
      },
      context.signal,
    );
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 1,
      hourly: 1,
    });

    const app = createApp({ signal: context.signal });
    const response = await app.request(
      cronCompactUsageEventsContract.compact.path,
      {
        method: cronCompactUsageEventsContract.compact.method,
        headers: cronHeaders(),
      },
    );

    expect(response.status).toBe(500);
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 1,
      hourly: 1,
    });
  });
});
