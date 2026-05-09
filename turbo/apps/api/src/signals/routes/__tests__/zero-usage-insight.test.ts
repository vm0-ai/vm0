import { randomUUID } from "node:crypto";

import { triggerSourceSchema } from "@vm0/api-contracts/contracts/logs";
import {
  type UsageInsightBucket,
  zeroUsageInsightContract,
} from "@vm0/api-contracts/contracts/zero-usage-insight";
import { createStore } from "ccstate";

import { afterEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow, nowDate } from "../../../lib/time";
import {
  deleteUsageInsightFixture$,
  insertModelUsageEventForRun$,
  insertUsageEvent$,
  seedChatThread$,
  seedCompose$,
  seedRun$,
  seedSchedule$,
  seedScheduleBatch$,
  seedUsageInsightFixture$,
  setUsageEventCreatedAt$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function apiClient() {
  return setupApp({ context })(zeroUsageInsightContract);
}

function sumBucketSeries(
  buckets: readonly UsageInsightBucket[],
): Record<string, { credits: number; tokens: number }> {
  const totals: Record<string, { credits: number; tokens: number }> = {};
  for (const bucket of buckets) {
    for (const [key, credits] of Object.entries(bucket.series)) {
      const current = totals[key] ?? { credits: 0, tokens: 0 };
      current.credits += credits;
      current.tokens += bucket.tokens[key] ?? 0;
      totals[key] = current;
    }
  }
  return totals;
}

describe("GET /api/zero/usage/insight", () => {
  const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
    return store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });

  afterEach(() => {
    clearMockNow();
  });

  it("returns 401 when not authenticated", async () => {
    const response = await accept(
      apiClient().get({
        query: { range: "7d", groupBy: "source", tz: "UTC" },
        headers: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 400 for invalid timezone", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({
        query: { range: "7d", groupBy: "source", tz: "Not/A/Timezone" },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 when range=day is missing a date", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({
        query: { range: "day", groupBy: "source", tz: "UTC" },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("happy path — shape and totals add up for range=7d groupBy=source tz=UTC", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        triggerSource: "web",
        status: "completed",
      },
      context.signal,
    );
    await store.set(
      insertModelUsageEventForRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId,
        inputTokens: 1000,
        outputTokens: 500,
        creditsCharged: 100,
        status: "processed",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({
        query: { range: "7d", groupBy: "source", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(Array.isArray(response.body.buckets)).toBeTruthy();
    expect(Array.isArray(response.body.schedules)).toBeTruthy();
    expect(Array.isArray(response.body.chats)).toBeTruthy();
    expect(typeof response.body.grandTotalCredits).toBe("number");
    expect(typeof response.body.grandTotalTokens).toBe("number");
    expect(response.body.grandTotalCredits).toBeGreaterThanOrEqual(100);

    const bucketSum = response.body.buckets.reduce((sum, bucket) => {
      const seriesSum = Object.values(bucket.series).reduce((s, v) => {
        return s + v;
      }, 0);
      return sum + seriesSum;
    }, 0);
    expect(bucketSum).toBeLessThanOrEqual(response.body.grandTotalCredits + 1);
  });

  it("source mapping — every TriggerSource lands in the correct bucket", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );

    for (const source of triggerSourceSchema.options) {
      const { runId } = await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId,
          triggerSource: source,
          status: "completed",
        },
        context.signal,
      );
      await store.set(
        insertModelUsageEventForRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          runId,
          creditsCharged: 50,
          status: "processed",
        },
        context.signal,
      );
    }

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const response = await accept(
      apiClient().get({
        query: { range: "7d", groupBy: "source", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );

    const totalByBucket: Record<string, number> = {};
    for (const bucket of response.body.buckets) {
      for (const [key, val] of Object.entries(bucket.series)) {
        totalByBucket[key] = (totalByBucket[key] ?? 0) + val;
      }
    }

    expect(totalByBucket["chat"]).toBeGreaterThanOrEqual(50);
    expect(totalByBucket["slack"]).toBeGreaterThanOrEqual(50);
    expect(totalByBucket["email"]).toBeGreaterThanOrEqual(50);
    expect(totalByBucket["schedule"]).toBeGreaterThanOrEqual(50);
    expect(totalByBucket["others"]).toBeGreaterThanOrEqual(250);
  });

  it("groupBy=agent with 9 agents produces top-7 + others series keys", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );

    for (let i = 1; i <= 9; i++) {
      const { composeId } = await store.set(
        seedCompose$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          name: `agent-${i}-${randomUUID().slice(0, 8)}`,
        },
        context.signal,
      );
      const { runId } = await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId,
          triggerSource: "cli",
          status: "completed",
        },
        context.signal,
      );
      await store.set(
        insertModelUsageEventForRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          runId,
          creditsCharged: i * 100,
          status: "processed",
        },
        context.signal,
      );
    }

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const response = await accept(
      apiClient().get({
        query: { range: "7d", groupBy: "agent", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );

    const seriesKeys = new Set<string>();
    for (const bucket of response.body.buckets) {
      for (const key of Object.keys(bucket.series)) {
        seriesKeys.add(key);
      }
    }
    expect(seriesKeys.size).toBeLessThanOrEqual(8);
    expect(seriesKeys.has("others")).toBeTruthy();
  });

  it("today produces hourly bucket strings", async () => {
    mockNow(new Date("2026-04-23T15:00:00Z"));
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );

    const todayStart = new Date("2026-04-23T00:00:00Z");
    const t1 = new Date(todayStart.getTime() + 9 * 3_600_000);
    const t2 = new Date(todayStart.getTime() + 12 * 3_600_000);

    const { runId: run1 } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        triggerSource: "cli",
        status: "completed",
      },
      context.signal,
    );
    const { id: cu1Id } = await store.set(
      insertModelUsageEventForRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: run1,
        creditsCharged: 10,
        status: "processed",
      },
      context.signal,
    );
    await store.set(
      setUsageEventCreatedAt$,
      { id: cu1Id, createdAt: t1 },
      context.signal,
    );

    const { runId: run2 } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        triggerSource: "cli",
        status: "completed",
      },
      context.signal,
    );
    const { id: cu2Id } = await store.set(
      insertModelUsageEventForRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: run2,
        creditsCharged: 10,
        status: "processed",
      },
      context.signal,
    );
    await store.set(
      setUsageEventCreatedAt$,
      { id: cu2Id, createdAt: t2 },
      context.signal,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const response = await accept(
      apiClient().get({
        query: { range: "today", groupBy: "source", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.buckets.length).toBeGreaterThanOrEqual(1);
    for (const bucket of response.body.buckets) {
      expect(bucket.ts).toMatch(/:00:00/);
    }
  });

  it("yesterday produces hourly bucket strings for prior calendar day", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );

    const now = nowDate();
    const yesterdayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
    );
    const t1 = new Date(yesterdayStart.getTime() + 10 * 3_600_000);
    const t2 = new Date(yesterdayStart.getTime() + 14 * 3_600_000);

    const { runId: run1 } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        triggerSource: "cli",
        status: "completed",
      },
      context.signal,
    );
    const { id: cu1Id } = await store.set(
      insertModelUsageEventForRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: run1,
        creditsCharged: 10,
        status: "processed",
      },
      context.signal,
    );
    await store.set(
      setUsageEventCreatedAt$,
      { id: cu1Id, createdAt: t1 },
      context.signal,
    );

    const { runId: run2 } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        triggerSource: "cli",
        status: "completed",
      },
      context.signal,
    );
    const { id: cu2Id } = await store.set(
      insertModelUsageEventForRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: run2,
        creditsCharged: 10,
        status: "processed",
      },
      context.signal,
    );
    await store.set(
      setUsageEventCreatedAt$,
      { id: cu2Id, createdAt: t2 },
      context.signal,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const response = await accept(
      apiClient().get({
        query: { range: "yesterday", groupBy: "source", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.buckets.length).toBeGreaterThanOrEqual(2);

    const yesterdayDate = yesterdayStart.toISOString().split("T")[0];
    expect(yesterdayDate).toBeDefined();
    for (const bucket of response.body.buckets) {
      expect(bucket.ts).toMatch(/:00:00/);
      expect(bucket.ts).toContain(yesterdayDate);
    }

    const first = response.body.buckets[0];
    const last = response.body.buckets[response.body.buckets.length - 1];
    if (first && last) {
      expect(first.ts).not.toBe(last.ts);
    }
  });

  it("7d window includes data from midnight 6 days ago", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );

    const now = nowDate();
    const todayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const sixDaysAgo = new Date(todayStart.getTime() - 6 * 86_400_000);
    const runTime = new Date(sixDaysAgo.getTime() + 3_600_000);

    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        triggerSource: "cli",
        status: "completed",
      },
      context.signal,
    );
    const { id: cuId } = await store.set(
      insertModelUsageEventForRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId,
        creditsCharged: 42,
        status: "processed",
      },
      context.signal,
    );
    await store.set(
      setUsageEventCreatedAt$,
      { id: cuId, createdAt: runTime },
      context.signal,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const response = await accept(
      apiClient().get({
        query: { range: "7d", groupBy: "source", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );

    const bucket = response.body.buckets.find((b) => {
      return Object.values(b.series).some((v) => {
        return v === 42;
      });
    });
    expect(bucket).toBeDefined();
    const sixDaysAgoDate = sixDaysAgo.toISOString().split("T")[0];
    expect(sixDaysAgoDate).toBeDefined();
    expect(bucket?.ts).toContain(sixDaysAgoDate);
  });

  it("day window includes only the selected calendar day", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );

    const now = nowDate();
    const todayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const selectedStart = new Date(todayStart.getTime() - 5 * 86_400_000);
    const selectedDate = selectedStart.toISOString().split("T")[0];
    expect(selectedDate).toBeDefined();

    const { runId: selectedRunId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        triggerSource: "cli",
        status: "completed",
      },
      context.signal,
    );
    const { id: selectedUsageId } = await store.set(
      insertModelUsageEventForRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: selectedRunId,
        creditsCharged: 42,
        status: "processed",
      },
      context.signal,
    );
    await store.set(
      setUsageEventCreatedAt$,
      {
        id: selectedUsageId,
        createdAt: new Date(selectedStart.getTime() + 3_600_000),
      },
      context.signal,
    );

    const { runId: outsideRunId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        triggerSource: "cli",
        status: "completed",
      },
      context.signal,
    );
    const { id: outsideUsageId } = await store.set(
      insertModelUsageEventForRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: outsideRunId,
        creditsCharged: 99,
        status: "processed",
      },
      context.signal,
    );
    await store.set(
      setUsageEventCreatedAt$,
      {
        id: outsideUsageId,
        createdAt: new Date(selectedStart.getTime() + 86_400_000 + 3_600_000),
      },
      context.signal,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const response = await accept(
      apiClient().get({
        query: {
          range: "day",
          date: selectedDate,
          groupBy: "source",
          tz: "UTC",
        },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.grandTotalCredits).toBe(42);
    expect(response.body.buckets[0]?.ts).toContain(selectedDate);
  });

  it("tz shift — same row appears in different date buckets by timezone", async () => {
    mockNow(new Date("2026-04-23T15:00:00Z"));
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        triggerSource: "cli",
        status: "completed",
      },
      context.signal,
    );
    const { id: cuId } = await store.set(
      insertModelUsageEventForRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId,
        creditsCharged: 42,
        status: "processed",
      },
      context.signal,
    );
    const now = new Date("2026-04-23T15:00:00Z");
    const rowTime = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - 3,
        0,
        30,
      ),
    );
    const dateInTimeZone = (date: Date, timeZone: string): string => {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(date);
      const value = (type: string): string => {
        const part = parts.find((entry) => {
          return entry.type === type;
        });
        if (!part) {
          throw new Error(`Missing date part: ${type}`);
        }
        return part.value;
      };
      return `${value("year")}-${value("month")}-${value("day")}`;
    };
    const expectedUtcDate = dateInTimeZone(rowTime, "UTC");
    const expectedLaDate = dateInTimeZone(rowTime, "America/Los_Angeles");
    await store.set(
      setUsageEventCreatedAt$,
      { id: cuId, createdAt: rowTime },
      context.signal,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const responseUtc = await accept(
      apiClient().get({
        query: { range: "7d", groupBy: "source", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );
    const responseLa = await accept(
      apiClient().get({
        query: {
          range: "7d",
          groupBy: "source",
          tz: "America/Los_Angeles",
        },
        headers: authHeaders(),
      }),
      [200],
    );

    const findBucketWith42Credits = (
      buckets: readonly UsageInsightBucket[],
    ): UsageInsightBucket | undefined => {
      return buckets.find((bucket) => {
        const total = Object.values(bucket.series).reduce((s, v) => {
          return s + v;
        }, 0);
        return total === 42;
      });
    };

    const utcBucket = findBucketWith42Credits(responseUtc.body.buckets);
    const laBucket = findBucketWith42Credits(responseLa.body.buckets);

    expect(utcBucket).toBeDefined();
    expect(laBucket).toBeDefined();
    expect(utcBucket?.ts).toContain(expectedUtcDate);
    expect(laBucket?.ts).toContain(expectedLaDate);
    expect(expectedUtcDate).not.toBe(expectedLaDate);
  });

  it("top-100 truncation — 105 schedules → schedules.length === 100, otherCount === 5", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );

    const { scheduleIds } = await store.set(
      seedScheduleBatch$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        count: 105,
        creditsForIndex: (i) => {
          return i + 1;
        },
        bonusUsageEventForIndex: (i) => {
          if (i !== 0) {
            return null;
          }
          return {
            kind: "connector",
            provider: "x",
            category: "tweet.read",
            quantity: 1,
            creditsCharged: 10_000,
            status: "processed",
          };
        },
      },
      context.signal,
    );
    const eventBoostedScheduleId = scheduleIds[0];
    expect(eventBoostedScheduleId).toBeDefined();

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const response = await accept(
      apiClient().get({
        query: { range: "28d", groupBy: "source", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.schedules).toHaveLength(100);
    expect(response.body.scheduleOtherCount).toBe(5);
    expect(response.body.schedules[0]).toMatchObject({
      scheduleId: eventBoostedScheduleId,
      credits: 10_001,
    });
  });

  it("returns scheduleDescription alongside scheduleName for scheduled runs", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId: agentA } = await store.set(
      seedCompose$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: `compose-a-${randomUUID().slice(0, 8)}`,
      },
      context.signal,
    );
    const { composeId: agentB } = await store.set(
      seedCompose$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: `compose-b-${randomUUID().slice(0, 8)}`,
      },
      context.signal,
    );

    const describedScheduleId = await store.set(
      seedSchedule$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId: agentA,
        name: "default",
        description: "Daily morning brief",
      },
      context.signal,
    );
    const undescribedScheduleId = await store.set(
      seedSchedule$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId: agentB,
        name: "default",
      },
      context.signal,
    );

    for (const [agentId, scheduleId] of [
      [agentA, describedScheduleId],
      [agentB, undescribedScheduleId],
    ] as const) {
      const { runId } = await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId: agentId,
          triggerSource: "schedule",
          scheduleId,
          status: "completed",
        },
        context.signal,
      );
      await store.set(
        insertModelUsageEventForRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          runId,
          creditsCharged: 50,
          status: "processed",
        },
        context.signal,
      );
    }

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const response = await accept(
      apiClient().get({
        query: { range: "7d", groupBy: "source", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );

    const described = response.body.schedules.find((s) => {
      return s.scheduleId === describedScheduleId;
    });
    const undescribed = response.body.schedules.find((s) => {
      return s.scheduleId === undescribedScheduleId;
    });
    expect(described?.scheduleDescription).toBe("Daily morning brief");
    expect(undescribed?.scheduleDescription).toBeNull();
  });

  it("scope isolation — other user's activity in same org is invisible", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const otherFixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    // Override otherFixture to use the same org as the main fixture so the
    // assertion specifically checks user-level scoping (not org-level).
    const otherUserId = otherFixture.userId;

    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId: myRunId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        triggerSource: "web",
        status: "completed",
      },
      context.signal,
    );
    await store.set(
      insertModelUsageEventForRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: myRunId,
        creditsCharged: 100,
        status: "processed",
      },
      context.signal,
    );

    const { composeId: otherComposeId } = await store.set(
      seedCompose$,
      {
        orgId: fixture.orgId,
        userId: otherUserId,
        name: `other-compose-${randomUUID().slice(0, 8)}`,
      },
      context.signal,
    );
    const { runId: otherRunId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: otherUserId,
        composeId: otherComposeId,
        triggerSource: "web",
        status: "completed",
      },
      context.signal,
    );
    await store.set(
      insertModelUsageEventForRun$,
      {
        orgId: fixture.orgId,
        userId: otherUserId,
        runId: otherRunId,
        creditsCharged: 999,
        status: "processed",
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: otherUserId,
        runId: otherRunId,
        kind: "connector",
        provider: "x",
        category: "tweet.read",
        quantity: 1,
        creditsCharged: 999,
        status: "processed",
      },
      context.signal,
    );

    // Track the other user's rows through their own fixture so cleanup
    // catches them; we explicitly seeded under otherUserId+fixture.orgId.
    await track(
      Promise.resolve({
        orgId: fixture.orgId,
        userId: otherUserId,
      }),
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const response = await accept(
      apiClient().get({
        query: { range: "7d", groupBy: "source", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.grandTotalCredits).toBe(100);
  });

  it("includes usage_event rows in grand totals and source buckets", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        triggerSource: "web",
        status: "completed",
      },
      context.signal,
    );

    await store.set(
      insertModelUsageEventForRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId,
        inputTokens: 100,
        outputTokens: 50,
        creditsCharged: 10,
        status: "processed",
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.input",
        quantity: 30,
        creditsCharged: 3,
        status: "processed",
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.output",
        quantity: 20,
        creditsCharged: 2,
        status: "processed",
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.cache_read",
        quantity: 5,
        creditsCharged: 1,
        status: "processed",
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.cache_creation",
        quantity: 10,
        creditsCharged: 4,
        status: "processed",
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        kind: "connector",
        provider: "x",
        category: "tweet.read",
        quantity: 1,
        creditsCharged: 7,
        status: "processed",
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.input",
        quantity: 999,
        creditsCharged: 999,
        status: "pending",
      },
      context.signal,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const response = await accept(
      apiClient().get({
        query: { range: "7d", groupBy: "source", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );
    const totals = sumBucketSeries(response.body.buckets);

    expect(response.body.grandTotalCredits).toBe(27);
    expect(response.body.grandTotalTokens).toBe(215);
    expect(totals["chat"]).toStrictEqual({ credits: 20, tokens: 215 });
    expect(totals["others"]).toStrictEqual({ credits: 7, tokens: 0 });
  });

  it("buckets usage_event rows by activity time, not billing time", async () => {
    mockNow(new Date("2026-04-23T15:00:00Z"));
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );

    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        kind: "connector",
        provider: "x",
        category: "tweet.read",
        quantity: 1,
        creditsCharged: 33,
        status: "processed",
        createdAt: new Date("2026-04-22T12:00:00Z"),
        processedAt: new Date("2026-04-23T12:00:00Z"),
      },
      context.signal,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const yesterdayResponse = await accept(
      apiClient().get({
        query: { range: "yesterday", groupBy: "source", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );
    const yesterdayTotals = sumBucketSeries(yesterdayResponse.body.buckets);

    expect(yesterdayResponse.body.grandTotalCredits).toBe(33);
    expect(yesterdayTotals["others"]).toStrictEqual({
      credits: 33,
      tokens: 0,
    });

    const todayResponse = await accept(
      apiClient().get({
        query: { range: "today", groupBy: "source", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(todayResponse.body.grandTotalCredits).toBe(0);
  });

  it("includes run-linked usage_event rows in agent buckets and channel totals", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const agentName = `usage-event-agent-${randomUUID().slice(0, 8)}`;
    const { composeId } = await store.set(
      seedCompose$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: agentName,
      },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        triggerSource: "slack",
        status: "completed",
      },
      context.signal,
    );

    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId,
        kind: "connector",
        provider: "x",
        category: "tweet.read",
        quantity: 1,
        creditsCharged: 40,
        status: "processed",
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.output",
        quantity: 15,
        creditsCharged: 5,
        status: "processed",
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        kind: "connector",
        provider: "x",
        category: "tweet.read",
        quantity: 1,
        creditsCharged: 8,
        status: "processed",
      },
      context.signal,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const response = await accept(
      apiClient().get({
        query: { range: "7d", groupBy: "agent", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );
    const totals = sumBucketSeries(response.body.buckets);

    expect(totals[agentName]).toStrictEqual({ credits: 45, tokens: 15 });
    expect(totals["others"]).toStrictEqual({ credits: 8, tokens: 0 });
    expect(response.body.slackCredits).toBe(45);
    expect(response.body.slackTokens).toBe(15);
  });

  it("returns chat rows when groupBy=source and there are chat runs", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const threadId = await store.set(
      seedChatThread$,
      {
        userId: fixture.userId,
        composeId,
        title: "Test Chat Thread",
      },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        triggerSource: "web",
        chatThreadId: threadId,
        status: "completed",
      },
      context.signal,
    );

    await store.set(
      insertModelUsageEventForRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId,
        creditsCharged: 200,
        status: "processed",
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.input",
        quantity: 12,
        creditsCharged: 25,
        status: "processed",
      },
      context.signal,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const response = await accept(
      apiClient().get({
        query: { range: "7d", groupBy: "source", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.chats.length).toBeGreaterThanOrEqual(1);
    const chat = response.body.chats.find((c) => {
      return c.threadId === threadId;
    });
    expect(chat).toBeDefined();
    expect(chat?.threadTitle).toBe("Test Chat Thread");
    expect(chat?.credits).toBe(225);
    expect(chat?.tokens).toBe(162);
  });

  it("top-100 truncation — overflow with creditsCharged=0 still reports correct otherCount", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );

    await store.set(
      seedScheduleBatch$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        count: 105,
        creditsForIndex: (i) => {
          return i < 5 ? 0 : i + 1;
        },
      },
      context.signal,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const response = await accept(
      apiClient().get({
        query: { range: "28d", groupBy: "source", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.schedules).toHaveLength(100);
    expect(response.body.scheduleOtherCount).toBe(5);
  });
});
