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

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const FIXED_NOW_ISO = "2026-05-12T12:00:00.000Z";

interface UsageFixture extends UsageInsightFixture {
  readonly composeId: string;
}

interface CompletedRunArgs {
  readonly createdAt: Date;
  readonly durationMs: number;
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
  args: CompletedRunArgs,
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

describe("GET /api/usage", () => {
  const track = createFixtureTracker<UsageFixture>((fixture) => {
    return deleteUsageFixture(fixture);
  });

  beforeEach(() => {
    mockNow(new Date(FIXED_NOW_ISO));
  });

  afterEach(() => {
    clearMockNow();
  });

  it("returns 401 when unauthenticated", async () => {
    const response = await accept(
      apiClient().get({ query: {}, headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns usage data with the default 7 day range", async () => {
    const fixture = await track(seedUsageFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId);
    await seedCompletedRun(fixture, {
      createdAt: new Date("2026-05-12T10:00:00.000Z"),
      durationMs: 60_000,
    });
    await seedCompletedRun(fixture, {
      createdAt: new Date("2026-05-12T11:00:00.000Z"),
      durationMs: 120_000,
    });

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body.period).toStrictEqual({
      start: "2026-05-05T12:00:00.000Z",
      end: "2026-05-12T12:00:00.000Z",
    });
    expect(response.body.summary).toStrictEqual({
      total_runs: 2,
      total_run_time_ms: 180_000,
    });
    expect(response.body.daily).toHaveLength(1);
    expect(response.body.daily[0]).toStrictEqual({
      date: "2026-05-12",
      run_count: 2,
      run_time_ms: 180_000,
    });
  });

  it("accepts a custom date range", async () => {
    const fixture = await track(seedUsageFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({
        query: {
          start_date: "2026-05-09T12:00:00.000Z",
          end_date: "2026-05-12T12:00:00.000Z",
        },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.period).toStrictEqual({
      start: "2026-05-09T12:00:00.000Z",
      end: "2026-05-12T12:00:00.000Z",
    });
  });

  it("treats empty date query parameters as the default range", async () => {
    const fixture = await track(seedUsageFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId);
    await seedCompletedRun(fixture, {
      createdAt: new Date("2026-05-12T10:00:00.000Z"),
      durationMs: 60_000,
    });

    const response = await accept(
      apiClient().get({
        query: { start_date: "", end_date: "" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.period).toStrictEqual({
      start: "2026-05-05T12:00:00.000Z",
      end: "2026-05-12T12:00:00.000Z",
    });
    expect(response.body.summary).toStrictEqual({
      total_runs: 1,
      total_run_time_ms: 60_000,
    });
  });

  it("rejects invalid start_date format", async () => {
    const fixture = await track(seedUsageFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({
        query: { start_date: "invalid" },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(response.body.error.message).toContain("Invalid start_date format");
  });

  it("rejects invalid end_date format", async () => {
    const fixture = await track(seedUsageFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({
        query: { end_date: "invalid" },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(response.body.error.message).toContain("Invalid end_date format");
  });

  it("rejects start_date after end_date", async () => {
    const fixture = await track(seedUsageFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({
        query: {
          start_date: "2026-05-12T12:00:00.000Z",
          end_date: "2026-05-11T12:00:00.000Z",
        },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(response.body.error.message).toContain(
      "start_date must be before end_date",
    );
  });

  it("rejects ranges exceeding 30 days", async () => {
    const fixture = await track(seedUsageFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({
        query: {
          start_date: "2026-04-01T12:00:00.000Z",
          end_date: "2026-05-12T12:00:00.000Z",
        },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(response.body.error.message).toContain(
      "Time range exceeds maximum of 30 days",
    );
  });

  it("returns daily breakdown rows and summary totals", async () => {
    const fixture = await track(seedUsageFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId);
    await seedCompletedRun(fixture, {
      createdAt: new Date("2026-05-12T09:00:00.000Z"),
      durationMs: 45_000,
    });
    await seedCompletedRun(fixture, {
      createdAt: new Date("2026-05-12T10:00:00.000Z"),
      durationMs: 15_000,
    });

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body.summary.total_runs).toBe(2);
    expect(response.body.summary.total_run_time_ms).toBe(60_000);
    for (const day of response.body.daily) {
      expect(typeof day.date).toBe("string");
      expect(typeof day.run_count).toBe("number");
      expect(typeof day.run_time_ms).toBe("number");
    }
  });

  it("calculates run times correctly with explicit timestamps", async () => {
    const fixture = await track(seedUsageFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId);
    await seedCompletedRun(fixture, {
      createdAt: new Date("2026-05-12T09:00:00.000Z"),
      durationMs: 60_000,
    });
    await seedCompletedRun(fixture, {
      createdAt: new Date("2026-05-12T10:00:00.000Z"),
      durationMs: 120_000,
    });

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body.summary.total_runs).toBe(2);
    expect(response.body.summary.total_run_time_ms).toBe(180_000);
  });

  it("aggregates historical runs across multiple days", async () => {
    const fixture = await track(seedUsageFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId);
    await seedCompletedRun(fixture, {
      createdAt: new Date("2026-05-08T10:00:00.000Z"),
      durationMs: 5000,
    });
    await seedCompletedRun(fixture, {
      createdAt: new Date("2026-05-09T10:00:00.000Z"),
      durationMs: 8000,
    });

    const response = await accept(
      apiClient().get({
        query: {
          start_date: "2026-05-07T00:00:00.000Z",
          end_date: "2026-05-12T12:00:00.000Z",
        },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.summary).toStrictEqual({
      total_runs: 2,
      total_run_time_ms: 13_000,
    });
    expect(response.body.daily).toStrictEqual([
      { date: "2026-05-09", run_count: 1, run_time_ms: 8000 },
      { date: "2026-05-08", run_count: 1, run_time_ms: 5000 },
    ]);
  });

  it("uses agent_runs for partial start day boundaries", async () => {
    const fixture = await track(seedUsageFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId);
    await seedCompletedRun(fixture, {
      createdAt: new Date("2026-05-10T08:00:00.000Z"),
      durationMs: 3000,
    });
    await seedCompletedRun(fixture, {
      createdAt: new Date("2026-05-10T14:00:00.000Z"),
      durationMs: 5000,
    });

    const response = await accept(
      apiClient().get({
        query: {
          start_date: "2026-05-10T14:00:00.000Z",
          end_date: "2026-05-12T12:00:00.000Z",
        },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.daily).toStrictEqual([
      { date: "2026-05-10", run_count: 1, run_time_ms: 5000 },
    ]);
  });

  it("caches computed historical results for subsequent queries", async () => {
    const fixture = await track(seedUsageFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId);
    await seedCompletedRun(fixture, {
      createdAt: new Date("2026-05-08T10:00:00.000Z"),
      durationMs: 6000,
    });

    const request = {
      query: {
        start_date: "2026-05-07T00:00:00.000Z",
        end_date: "2026-05-12T12:00:00.000Z",
      },
      headers: authHeaders(),
    };

    const first = await accept(apiClient().get(request), [200]);
    expect(first.body.summary.total_runs).toBe(1);
    expect(first.body.summary.total_run_time_ms).toBe(6000);

    const cached = await findCachedUsage(fixture, "2026-05-08");
    expect(cached).toStrictEqual({ runCount: 1, runTimeMs: 6000 });

    const second = await accept(apiClient().get(request), [200]);
    expect(second.body.summary).toStrictEqual(first.body.summary);
    expect(second.body.daily).toStrictEqual(first.body.daily);
  });

  it("only returns usage for the authenticated org", async () => {
    const fixture = await track(seedUsageFixture());
    const otherFixture = await track(seedUsageFixture());
    await seedCompletedRun(fixture, {
      createdAt: new Date("2026-05-12T10:00:00.000Z"),
      durationMs: 5000,
    });
    await seedCompletedRun(otherFixture, {
      createdAt: new Date("2026-05-12T10:00:00.000Z"),
      durationMs: 8000,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body.summary).toStrictEqual({
      total_runs: 1,
      total_run_time_ms: 5000,
    });
  });
});
