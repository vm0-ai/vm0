import { randomUUID } from "node:crypto";

import { usageContract } from "@vm0/api-contracts/contracts/usage";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { usageDaily } from "@vm0/db/schema/usage-daily";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `usage.test.ts`. The 13
// legacy `it()`s collapse into 3 BDD `it()`s: (1) auth +
// range chain (401 unauthenticated → 200 default 7-day
// range with daily summary → 200 custom range echoed in
// period → 200 empty date params treated as default), (2)
// validation chain (400 invalid start_date → 400 invalid
// end_date → 400 start_date after end_date → 400 range
// exceeds 30 days), (3) aggregation + cache + isolation
// chain (200 daily breakdown rows + summary totals → 200
// run times computed from explicit timestamps → 200
// historical runs aggregated across days → 200 partial
// start day uses agent_runs for boundary → 200 cached
// results reused on subsequent queries → 200 only returns
// usage for the authenticated org).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const FIXED_NOW_ISO = "2026-05-12T12:00:00.000Z";

interface UsageFixture extends UsageInsightFixture {
  readonly composeId: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function apiClient() {
  return setupApp({ context })(usageContract);
}

async function deleteUsageFixture(fixture: UsageFixture): Promise<void> {
  const db = store.set(writeDb$);
  await db
    .delete(usageDaily)
    .where(
      and(
        eq(usageDaily.orgId, fixture.orgId),
        eq(usageDaily.userId, fixture.userId),
      ),
    );
  await store.set(deleteUsageInsightFixture$, fixture, context.signal);
}

async function seedUsageFixture(): Promise<UsageFixture> {
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
      name: `usage-${randomUUID().slice(0, 8)}`,
    },
    context.signal,
  );
  return { ...base, composeId };
}

async function seedCompletedRun(
  fixture: UsageFixture,
  args: { readonly createdAt: Date; readonly durationMs: number },
): Promise<string> {
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      composeId: fixture.composeId,
      status: "completed",
    },
    context.signal,
  );
  const db = store.set(writeDb$);
  await db
    .update(agentRuns)
    .set({
      createdAt: args.createdAt,
      startedAt: args.createdAt,
      completedAt: new Date(args.createdAt.getTime() + args.durationMs),
    })
    .where(eq(agentRuns.id, runId));
  return runId;
}

async function findCachedUsage(
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

describe("BDD GET /api/usage — auth + range chain", () => {
  const track = createFixtureTracker<UsageFixture>((fixture) => {
    return deleteUsageFixture(fixture);
  });

  beforeEach(() => {
    mockNow(new Date(FIXED_NOW_ISO));
  });

  afterEach(() => {
    clearMockNow();
  });

  it("gwt-wt-wt: 401 unauthenticated → 200 default 7-day range with daily summary → 200 custom range echoed in period → 200 empty date params treated as default", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(
      apiClient().get({ query: {}, headers: {} }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a fixture + 2 completed runs on the current
    // day.
    const defaultFixture = await track(seedUsageFixture());
    mocks.clerk.session(defaultFixture.userId, defaultFixture.orgId);
    await seedCompletedRun(defaultFixture, {
      createdAt: new Date("2026-05-12T10:00:00.000Z"),
      durationMs: 60_000,
    });
    await seedCompletedRun(defaultFixture, {
      createdAt: new Date("2026-05-12T11:00:00.000Z"),
      durationMs: 120_000,
    });

    // When + Then: 200 — period is the 7-day default
    // range + summary aggregates the 2 runs + daily
    // breakdown has 1 entry.
    const defaultResponse = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );
    expect(defaultResponse.body.period).toStrictEqual({
      start: "2026-05-05T12:00:00.000Z",
      end: "2026-05-12T12:00:00.000Z",
    });
    expect(defaultResponse.body.summary).toStrictEqual({
      total_runs: 2,
      total_run_time_ms: 180_000,
    });
    expect(defaultResponse.body.daily).toHaveLength(1);
    expect(defaultResponse.body.daily[0]).toStrictEqual({
      date: "2026-05-12",
      run_count: 2,
      run_time_ms: 180_000,
    });

    // Given: a fresh fixture + an explicit custom range.
    const customFixture = await track(seedUsageFixture());
    mocks.clerk.session(customFixture.userId, customFixture.orgId);

    // When + Then: 200 — period reflects the custom
    // start_date and end_date.
    const customResponse = await accept(
      apiClient().get({
        query: {
          start_date: "2026-05-09T12:00:00.000Z",
          end_date: "2026-05-12T12:00:00.000Z",
        },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(customResponse.body.period).toStrictEqual({
      start: "2026-05-09T12:00:00.000Z",
      end: "2026-05-12T12:00:00.000Z",
    });

    // Given: a fresh fixture + empty date params.
    const emptyFixture = await track(seedUsageFixture());
    mocks.clerk.session(emptyFixture.userId, emptyFixture.orgId);
    await seedCompletedRun(emptyFixture, {
      createdAt: new Date("2026-05-12T10:00:00.000Z"),
      durationMs: 60_000,
    });

    // When + Then: 200 — empty date params fall back to
    // the default 7-day range.
    const emptyResponse = await accept(
      apiClient().get({
        query: { start_date: "", end_date: "" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(emptyResponse.body.period).toStrictEqual({
      start: "2026-05-05T12:00:00.000Z",
      end: "2026-05-12T12:00:00.000Z",
    });
    expect(emptyResponse.body.summary).toStrictEqual({
      total_runs: 1,
      total_run_time_ms: 60_000,
    });
  });
});

describe("BDD GET /api/usage — validation chain", () => {
  const track = createFixtureTracker<UsageFixture>((fixture) => {
    return deleteUsageFixture(fixture);
  });

  beforeEach(() => {
    mockNow(new Date(FIXED_NOW_ISO));
  });

  afterEach(() => {
    clearMockNow();
  });

  it("gwt-wt-wt: 400 invalid start_date → 400 invalid end_date → 400 start_date after end_date → 400 range exceeds 30 days", async () => {
    // Given: a fresh fixture.

    // When + Then: 400 — invalid start_date format.
    const badStart = await track(seedUsageFixture());
    mocks.clerk.session(badStart.userId, badStart.orgId);
    const badStartResponse = await accept(
      apiClient().get({
        query: { start_date: "invalid" },
        headers: authHeaders(),
      }),
      [400],
    );
    expect(badStartResponse.body.error.message).toContain(
      "Invalid start_date format",
    );

    // Given: a fresh fixture.

    // When + Then: 400 — invalid end_date format.
    const badEnd = await track(seedUsageFixture());
    mocks.clerk.session(badEnd.userId, badEnd.orgId);
    const badEndResponse = await accept(
      apiClient().get({
        query: { end_date: "invalid" },
        headers: authHeaders(),
      }),
      [400],
    );
    expect(badEndResponse.body.error.message).toContain(
      "Invalid end_date format",
    );

    // Given: a fresh fixture + start_date > end_date.

    // When + Then: 400 — start_date must be before
    // end_date.
    const inverted = await track(seedUsageFixture());
    mocks.clerk.session(inverted.userId, inverted.orgId);
    const invertedResponse = await accept(
      apiClient().get({
        query: {
          start_date: "2026-05-12T12:00:00.000Z",
          end_date: "2026-05-11T12:00:00.000Z",
        },
        headers: authHeaders(),
      }),
      [400],
    );
    expect(invertedResponse.body.error.message).toContain(
      "start_date must be before end_date",
    );

    // Given: a fresh fixture + a >30-day range.

    // When + Then: 400 — range exceeds the 30-day max.
    const tooWide = await track(seedUsageFixture());
    mocks.clerk.session(tooWide.userId, tooWide.orgId);
    const tooWideResponse = await accept(
      apiClient().get({
        query: {
          start_date: "2026-04-01T12:00:00.000Z",
          end_date: "2026-05-12T12:00:00.000Z",
        },
        headers: authHeaders(),
      }),
      [400],
    );
    expect(tooWideResponse.body.error.message).toContain(
      "Time range exceeds maximum of 30 days",
    );
  });
});

describe("BDD GET /api/usage — aggregation + cache + isolation chain", () => {
  const track = createFixtureTracker<UsageFixture>((fixture) => {
    return deleteUsageFixture(fixture);
  });

  beforeEach(() => {
    mockNow(new Date(FIXED_NOW_ISO));
  });

  afterEach(() => {
    clearMockNow();
  });

  it("gwt-wt-wt: 200 daily breakdown rows + summary totals → 200 run times computed from explicit timestamps → 200 historical runs aggregated across days → 200 partial start day uses agent_runs for boundary → 200 cached results reused on subsequent queries → 200 only returns usage for the authenticated org", async () => {
    // Given: a fixture + 2 runs on the current day.

    // When + Then: 200 — daily breakdown rows + summary
    // totals aggregate to 2 runs / 60_000 ms.
    const breakdownFixture = await track(seedUsageFixture());
    mocks.clerk.session(breakdownFixture.userId, breakdownFixture.orgId);
    await seedCompletedRun(breakdownFixture, {
      createdAt: new Date("2026-05-12T09:00:00.000Z"),
      durationMs: 45_000,
    });
    await seedCompletedRun(breakdownFixture, {
      createdAt: new Date("2026-05-12T10:00:00.000Z"),
      durationMs: 15_000,
    });
    const breakdownResponse = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );
    expect(breakdownResponse.body.summary.total_runs).toBe(2);
    expect(breakdownResponse.body.summary.total_run_time_ms).toBe(60_000);
    for (const day of breakdownResponse.body.daily) {
      expect(typeof day.date).toBe("string");
      expect(typeof day.run_count).toBe("number");
      expect(typeof day.run_time_ms).toBe("number");
    }

    // Given: a fresh fixture + 2 runs with explicit
    // timestamps.

    // When + Then: 200 — run times are summed from
    // explicit timestamps.
    const explicitFixture = await track(seedUsageFixture());
    mocks.clerk.session(explicitFixture.userId, explicitFixture.orgId);
    await seedCompletedRun(explicitFixture, {
      createdAt: new Date("2026-05-12T09:00:00.000Z"),
      durationMs: 60_000,
    });
    await seedCompletedRun(explicitFixture, {
      createdAt: new Date("2026-05-12T10:00:00.000Z"),
      durationMs: 120_000,
    });
    const explicitResponse = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );
    expect(explicitResponse.body.summary.total_runs).toBe(2);
    expect(explicitResponse.body.summary.total_run_time_ms).toBe(180_000);

    // Given: a fresh fixture + runs on different days.

    // When + Then: 200 — historical runs are aggregated
    // across days + daily breakdown lists each day.
    const historicalFixture = await track(seedUsageFixture());
    mocks.clerk.session(historicalFixture.userId, historicalFixture.orgId);
    await seedCompletedRun(historicalFixture, {
      createdAt: new Date("2026-05-08T10:00:00.000Z"),
      durationMs: 5000,
    });
    await seedCompletedRun(historicalFixture, {
      createdAt: new Date("2026-05-09T10:00:00.000Z"),
      durationMs: 8000,
    });
    const historicalResponse = await accept(
      apiClient().get({
        query: {
          start_date: "2026-05-07T00:00:00.000Z",
          end_date: "2026-05-12T12:00:00.000Z",
        },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(historicalResponse.body.summary).toStrictEqual({
      total_runs: 2,
      total_run_time_ms: 13_000,
    });
    expect(historicalResponse.body.daily).toStrictEqual([
      { date: "2026-05-09", run_count: 1, run_time_ms: 8000 },
      { date: "2026-05-08", run_count: 1, run_time_ms: 5000 },
    ]);

    // Given: a fresh fixture + a partial start day.

    // When + Then: 200 — partial start day uses
    // agent_runs for the start boundary.
    const partialFixture = await track(seedUsageFixture());
    mocks.clerk.session(partialFixture.userId, partialFixture.orgId);
    await seedCompletedRun(partialFixture, {
      createdAt: new Date("2026-05-10T08:00:00.000Z"),
      durationMs: 3000,
    });
    await seedCompletedRun(partialFixture, {
      createdAt: new Date("2026-05-10T14:00:00.000Z"),
      durationMs: 5000,
    });
    const partialResponse = await accept(
      apiClient().get({
        query: {
          start_date: "2026-05-10T14:00:00.000Z",
          end_date: "2026-05-12T12:00:00.000Z",
        },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(partialResponse.body.daily).toStrictEqual([
      { date: "2026-05-10", run_count: 1, run_time_ms: 5000 },
    ]);

    // Given: a fresh fixture + a single historical run.

    // When + Then: 200 — first call returns the run +
    // writes a `usage_daily` cache row + the second call
    // returns the same shape.
    const cacheFixture = await track(seedUsageFixture());
    mocks.clerk.session(cacheFixture.userId, cacheFixture.orgId);
    await seedCompletedRun(cacheFixture, {
      createdAt: new Date("2026-05-08T10:00:00.000Z"),
      durationMs: 6000,
    });
    const cacheRequest = {
      query: {
        start_date: "2026-05-07T00:00:00.000Z",
        end_date: "2026-05-12T12:00:00.000Z",
      },
      headers: authHeaders(),
    };
    const first = await accept(apiClient().get(cacheRequest), [200]);
    expect(first.body.summary.total_runs).toBe(1);
    expect(first.body.summary.total_run_time_ms).toBe(6000);
    const cached = await findCachedUsage(cacheFixture, "2026-05-08");
    expect(cached).toStrictEqual({ runCount: 1, runTimeMs: 6000 });
    const second = await accept(apiClient().get(cacheRequest), [200]);
    expect(second.body.summary).toStrictEqual(first.body.summary);
    expect(second.body.daily).toStrictEqual(first.body.daily);

    // Given: two fixtures with their own runs + a Clerk
    // session for only the first.

    // When + Then: 200 — only the authenticated org's
    // usage is returned.
    const isolationFixture = await track(seedUsageFixture());
    const otherFixture = await track(seedUsageFixture());
    await seedCompletedRun(isolationFixture, {
      createdAt: new Date("2026-05-12T10:00:00.000Z"),
      durationMs: 5000,
    });
    await seedCompletedRun(otherFixture, {
      createdAt: new Date("2026-05-12T10:00:00.000Z"),
      durationMs: 8000,
    });
    mocks.clerk.session(isolationFixture.userId, isolationFixture.orgId);
    const isolationResponse = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );
    expect(isolationResponse.body.summary).toStrictEqual({
      total_runs: 1,
      total_run_time_ms: 5000,
    });
  });
});
