import { cronAggregateUsageContract } from "@vm0/api-contracts/contracts/cron";
import { usageDaily } from "@vm0/db/schema/usage-daily";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow } from "../../../lib/time";
import { mockEnv } from "../../../lib/env";
import { writeDb$ } from "../../external/db";
import {
  deleteUsageFixture$,
  seedRun$,
  seedUsageFixture$,
  type UsageFixture,
} from "./helpers/zero-usage";
import { createFixtureTracker } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const FIXED_NOW_ISO = "2026-05-12T12:00:00.000Z";

function apiClient() {
  return setupApp({ context })(cronAggregateUsageContract);
}

function cronHeaders(secret = "test-cron-secret") {
  return { authorization: `Bearer ${secret}` };
}

async function cleanupFixture(fixture: UsageFixture): Promise<void> {
  const db = store.set(writeDb$);
  await db
    .delete(usageDaily)
    .where(
      and(
        eq(usageDaily.orgId, fixture.orgId),
        eq(usageDaily.userId, fixture.userId),
      ),
    );
  await store.set(deleteUsageFixture$, fixture, context.signal);
}

async function findUsageDaily(
  fixture: UsageFixture,
  date: string,
): Promise<{ readonly runCount: number; readonly runTimeMs: number } | null> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({
      runCount: usageDaily.runCount,
      runTimeMs: usageDaily.runTimeMs,
    })
    .from(usageDaily)
    .where(
      and(
        eq(usageDaily.orgId, fixture.orgId),
        eq(usageDaily.userId, fixture.userId),
        eq(usageDaily.date, date),
      ),
    )
    .limit(1);
  return row ?? null;
}

describe("GET /api/cron/aggregate-usage", () => {
  const track = createFixtureTracker<UsageFixture>(cleanupFixture);

  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
    mockNow(new Date(FIXED_NOW_ISO));
  });

  afterEach(() => {
    clearMockNow();
  });

  it("rejects requests with an invalid cron secret", async () => {
    const response = await accept(
      apiClient().aggregate({ headers: cronHeaders("wrong-secret") }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });

  it("aggregates previous-day completed runs and is idempotent", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const date = "2026-05-11";
    const run1Start = new Date("2026-05-11T10:00:00.000Z");
    const run2Start = new Date("2026-05-11T10:01:00.000Z");

    await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        createdAt: run1Start,
        startedAt: run1Start,
        completedAt: new Date(run1Start.getTime() + 5000),
      },
      context.signal,
    );
    await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        createdAt: run2Start,
        startedAt: run2Start,
        completedAt: new Date(run2Start.getTime() + 8000),
      },
      context.signal,
    );

    const first = await accept(
      apiClient().aggregate({ headers: cronHeaders() }),
      [200],
    );
    const second = await accept(
      apiClient().aggregate({ headers: cronHeaders() }),
      [200],
    );

    expect(first.body.date).toBe(date);
    expect(second.body.date).toBe(date);
    const usage = await findUsageDaily(fixture, date);
    expect(usage).toStrictEqual({ runCount: 2, runTimeMs: 13_000 });
  });

  it("returns a successful empty aggregation when no runs match", async () => {
    await track(store.set(seedUsageFixture$, {}, context.signal));

    const response = await accept(
      apiClient().aggregate({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      date: "2026-05-11",
      aggregated: expect.any(Number),
    });
  });
});
