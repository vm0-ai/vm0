import { describe, it, expect, beforeEach } from "vitest";
import {
  createTestRequest,
  insertTestCreditUsageForRun,
  setTestCreditUsageCreatedAt,
  seedTestSchedule,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { seedTestRun } from "../../../../../../src/__tests__/db-test-seeders/runs";
import {
  seedTestCompose,
  insertTestChatThread,
} from "../../../../../../src/__tests__/db-test-seeders/agents";
import {
  type UsageInsightResponse,
  type UsageInsightBucket,
} from "@vm0/api-contracts/contracts/zero-usage-insight";
import { triggerSourceSchema } from "@vm0/api-contracts/contracts/logs";

import { GET } from "../route";

const context = testContext();

function makeRequest(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  return createTestRequest(
    `http://localhost:3000/api/zero/usage/insight?${qs}`,
  );
}

describe("GET /api/zero/usage/insight", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const response = await GET(
      makeRequest({ range: "7d", groupBy: "source", tz: "UTC" }),
    );
    expect(response.status).toBe(401);
  });

  it("returns 400 for invalid timezone", async () => {
    const response = await GET(
      makeRequest({ range: "7d", groupBy: "source", tz: "Not/A/Timezone" }),
    );
    expect(response.status).toBe(400);
  });

  it("happy path — shape and totals add up for range=7d groupBy=source tz=UTC", async () => {
    const { userId, orgId } = await context.user;
    const { composeId } = await seedTestCompose({
      userId,
      name: uniqueId("compose"),
      orgId,
    });
    const { runId } = await seedTestRun(userId, composeId, {
      triggerSource: "web",
      status: "completed",
    });
    await insertTestCreditUsageForRun({
      runId,
      orgId,
      userId,
      inputTokens: 1000,
      outputTokens: 500,
      creditsCharged: 100,
      status: "processed",
    });

    const response = await GET(
      makeRequest({ range: "7d", groupBy: "source", tz: "UTC" }),
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as UsageInsightResponse;

    // Shape check
    expect(Array.isArray(data.buckets)).toBe(true);
    expect(Array.isArray(data.schedules)).toBe(true);
    expect(Array.isArray(data.chats)).toBe(true);
    expect(typeof data.grandTotalCredits).toBe("number");
    expect(typeof data.grandTotalTokens).toBe("number");

    // Grand total should include the inserted credit usage
    expect(data.grandTotalCredits).toBeGreaterThanOrEqual(100);

    // Totals across bucket series should be <= grandTotal
    const bucketSum = data.buckets.reduce(
      (sum: number, b: UsageInsightBucket) => {
        const seriesSum = Object.values(b.series).reduce(
          (s: number, v: number) => {
            return s + v;
          },
          0,
        );
        return sum + seriesSum;
      },
      0,
    );
    expect(bucketSum).toBeLessThanOrEqual(data.grandTotalCredits + 1); // +1 for rounding
  });

  it("source mapping — every TriggerSource lands in the correct bucket", async () => {
    const { userId, orgId } = await context.user;
    const { composeId } = await seedTestCompose({
      userId,
      name: uniqueId("compose"),
      orgId,
    });

    // Seed one run per trigger source
    for (const source of triggerSourceSchema.options) {
      const { runId } = await seedTestRun(userId, composeId, {
        triggerSource: source,
        status: "completed",
      });
      await insertTestCreditUsageForRun({
        runId,
        orgId,
        userId,
        creditsCharged: 50,
        status: "processed",
      });
    }

    const response = await GET(
      makeRequest({ range: "7d", groupBy: "source", tz: "UTC" }),
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as UsageInsightResponse;

    // Aggregate all buckets by key
    const totalByBucket: Record<string, number> = {};
    for (const bucket of data.buckets) {
      for (const [key, val] of Object.entries(bucket.series)) {
        totalByBucket[key] = (totalByBucket[key] ?? 0) + val;
      }
    }

    // chat <- web (50 credits)
    expect(totalByBucket["chat"]).toBeGreaterThanOrEqual(50);
    // slack <- slack (50 credits)
    expect(totalByBucket["slack"]).toBeGreaterThanOrEqual(50);
    // email <- email (50 credits)
    expect(totalByBucket["email"]).toBeGreaterThanOrEqual(50);
    // schedule <- schedule (50 credits)
    expect(totalByBucket["schedule"]).toBeGreaterThanOrEqual(50);
    // others <- 5 other sources (250 credits)
    expect(totalByBucket["others"]).toBeGreaterThanOrEqual(250);
  });

  it("groupBy=agent with 9 agents produces top-7 + others series keys", async () => {
    const { userId, orgId } = await context.user;

    // Create 9 agents with varying credits
    for (let i = 1; i <= 9; i++) {
      const { composeId } = await seedTestCompose({
        userId,
        name: uniqueId(`agent-${i}`),
        orgId,
      });
      const { runId } = await seedTestRun(userId, composeId, {
        triggerSource: "cli",
        status: "completed",
      });
      await insertTestCreditUsageForRun({
        runId,
        orgId,
        userId,
        creditsCharged: i * 100, // Different amounts so ranking is deterministic
        status: "processed",
      });
    }

    const response = await GET(
      makeRequest({ range: "7d", groupBy: "agent", tz: "UTC" }),
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as UsageInsightResponse;

    // Collect all unique series keys across buckets
    const seriesKeys = new Set<string>();
    for (const bucket of data.buckets) {
      for (const key of Object.keys(bucket.series)) {
        seriesKeys.add(key);
      }
    }

    // Should have 8 series keys max: top-7 + "others"
    expect(seriesKeys.size).toBeLessThanOrEqual(8);
    // "others" should be present (we have 9 agents, so 2 go to "others")
    expect(seriesKeys.has("others")).toBe(true);
  });

  it("today produces hourly bucket strings", async () => {
    // Fix time so seeded 09:00/12:00 data is always inside the [todayStart, now) window
    context.mocks.date.setSystemTime(new Date("2026-04-23T15:00:00Z"));

    const { userId, orgId } = await context.user;
    const { composeId } = await seedTestCompose({
      userId,
      name: uniqueId("compose"),
      orgId,
    });

    const now = new Date();
    const todayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    // Seed two runs at fixed hours today (09:00 and 12:00 UTC)
    const t1 = new Date(todayStart.getTime() + 9 * 3600000);
    const t2 = new Date(todayStart.getTime() + 12 * 3600000);

    const { runId: run1 } = await seedTestRun(userId, composeId, {
      triggerSource: "cli",
      status: "completed",
    });
    const { id: cu1Id } = await insertTestCreditUsageForRun({
      runId: run1,
      orgId,
      userId,
      creditsCharged: 10,
      status: "processed",
    });
    await setTestCreditUsageCreatedAt(cu1Id, t1);

    const { runId: run2 } = await seedTestRun(userId, composeId, {
      triggerSource: "cli",
      status: "completed",
    });
    const { id: cu2Id } = await insertTestCreditUsageForRun({
      runId: run2,
      orgId,
      userId,
      creditsCharged: 10,
      status: "processed",
    });
    await setTestCreditUsageCreatedAt(cu2Id, t2);

    const response = await GET(
      makeRequest({ range: "today", groupBy: "source", tz: "UTC" }),
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as UsageInsightResponse;

    // At least one bucket should exist
    expect(data.buckets.length).toBeGreaterThanOrEqual(1);

    // All bucket timestamps should be truncated to the hour
    for (const bucket of data.buckets) {
      expect(bucket.ts).toMatch(/:00:00/);
    }
  });

  it("yesterday produces hourly bucket strings for prior calendar day", async () => {
    const { userId, orgId } = await context.user;
    const { composeId } = await seedTestCompose({
      userId,
      name: uniqueId("compose"),
      orgId,
    });

    const now = new Date();
    const yesterdayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
    );
    // Seed two runs at fixed hours yesterday (10:00 and 14:00 UTC)
    const t1 = new Date(yesterdayStart.getTime() + 10 * 3600000);
    const t2 = new Date(yesterdayStart.getTime() + 14 * 3600000);

    const { runId: run1 } = await seedTestRun(userId, composeId, {
      triggerSource: "cli",
      status: "completed",
    });
    const { id: cu1Id } = await insertTestCreditUsageForRun({
      runId: run1,
      orgId,
      userId,
      creditsCharged: 10,
      status: "processed",
    });
    await setTestCreditUsageCreatedAt(cu1Id, t1);

    const { runId: run2 } = await seedTestRun(userId, composeId, {
      triggerSource: "cli",
      status: "completed",
    });
    const { id: cu2Id } = await insertTestCreditUsageForRun({
      runId: run2,
      orgId,
      userId,
      creditsCharged: 10,
      status: "processed",
    });
    await setTestCreditUsageCreatedAt(cu2Id, t2);

    const response = await GET(
      makeRequest({ range: "yesterday", groupBy: "source", tz: "UTC" }),
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as UsageInsightResponse;

    // Should have at least 2 buckets (different hours)
    expect(data.buckets.length).toBeGreaterThanOrEqual(2);

    // All bucket timestamps should be truncated to the hour and contain yesterday's date
    const yesterdayDate = yesterdayStart.toISOString().split("T")[0];
    for (const bucket of data.buckets) {
      expect(bucket.ts).toMatch(/:00:00/);
      expect(bucket.ts).toContain(yesterdayDate);
    }

    // The two buckets should have different timestamps
    const first = data.buckets[0];
    const last = data.buckets[data.buckets.length - 1];
    if (first && last) {
      expect(first.ts).not.toBe(last.ts);
    }
  });

  it("7d window includes data from midnight 6 days ago", async () => {
    const { userId, orgId } = await context.user;
    const { composeId } = await seedTestCompose({
      userId,
      name: uniqueId("compose"),
      orgId,
    });

    const now = new Date();
    const todayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const sixDaysAgo = new Date(todayStart.getTime() - 6 * 86400000);
    const runTime = new Date(sixDaysAgo.getTime() + 3600000); // 1 hour after midnight

    const { runId } = await seedTestRun(userId, composeId, {
      triggerSource: "cli",
      status: "completed",
    });
    const { id: cuId } = await insertTestCreditUsageForRun({
      runId,
      orgId,
      userId,
      creditsCharged: 42,
      status: "processed",
    });
    await setTestCreditUsageCreatedAt(cuId, runTime);

    const response = await GET(
      makeRequest({ range: "7d", groupBy: "source", tz: "UTC" }),
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as UsageInsightResponse;

    // Find the bucket containing our 42 credits
    const bucket = data.buckets.find((b) => {
      return Object.values(b.series).some((v) => {
        return v === 42;
      });
    });
    expect(bucket).toBeDefined();
    expect(bucket!.ts).toContain(sixDaysAgo.toISOString().split("T")[0]);
  });

  it("TZ shift — same row appears in different date buckets by timezone", async () => {
    const { userId, orgId } = await context.user;
    const { composeId } = await seedTestCompose({
      userId,
      name: uniqueId("compose"),
      orgId,
    });
    const { runId } = await seedTestRun(userId, composeId, {
      triggerSource: "cli",
      status: "completed",
    });
    const { id: cuId } = await insertTestCreditUsageForRun({
      runId,
      orgId,
      userId,
      creditsCharged: 42,
      status: "processed",
    });
    // Pick a recent 00:30Z boundary row so it stays inside range=7d while
    // landing on different calendar days in UTC vs America/Los_Angeles.
    const now = new Date();
    const rowTime = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - 3,
        0,
        30,
      ),
    );
    const dateInTimeZone = (date: Date, timeZone: string) => {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(date);
      const value = (type: string) => {
        return parts.find((part) => {
          return part.type === type;
        })!.value;
      };
      return `${value("year")}-${value("month")}-${value("day")}`;
    };
    const expectedUtcDate = dateInTimeZone(rowTime, "UTC");
    const expectedLaDate = dateInTimeZone(rowTime, "America/Los_Angeles");
    await setTestCreditUsageCreatedAt(cuId, rowTime);

    const responseUtc = await GET(
      makeRequest({ range: "7d", groupBy: "source", tz: "UTC" }),
    );
    expect(responseUtc.status).toBe(200);
    const dataUtc = (await responseUtc.json()) as UsageInsightResponse;

    const responseLa = await GET(
      makeRequest({
        range: "7d",
        groupBy: "source",
        tz: "America/Los_Angeles",
      }),
    );
    expect(responseLa.status).toBe(200);
    const dataLa = (await responseLa.json()) as UsageInsightResponse;

    // Find the bucket containing our specific 42 credits row in each timezone
    // We look for the bucket where credits sum to exactly 42
    const findBucketWith42Credits = (buckets: UsageInsightBucket[]) => {
      return buckets.find((b) => {
        const total = Object.values(b.series).reduce((s: number, v: number) => {
          return s + v;
        }, 0);
        return total === 42;
      });
    };

    const utcBucket = findBucketWith42Credits(dataUtc.buckets);
    const laBucket = findBucketWith42Credits(dataLa.buckets);

    expect(utcBucket).toBeDefined();
    expect(laBucket).toBeDefined();
    expect(utcBucket!.ts).toContain(expectedUtcDate);
    expect(laBucket!.ts).toContain(expectedLaDate);
    expect(expectedUtcDate).not.toBe(expectedLaDate);
  });

  it("top-100 truncation — 105 schedules → schedules.length === 100, otherCount === 5", async () => {
    const { userId, orgId } = await context.user;
    const { composeId } = await seedTestCompose({
      userId,
      name: uniqueId("compose"),
      orgId,
    });

    // Seed 105 schedules in parallel, each with one run + credit usage
    await Promise.all(
      Array.from({ length: 105 }, async (_, i) => {
        const scheduleId = await seedTestSchedule({
          agentId: composeId,
          userId,
          orgId,
        });

        const { runId } = await seedTestRun(userId, composeId, {
          triggerSource: "schedule",
          scheduleId,
          status: "completed",
        });

        await insertTestCreditUsageForRun({
          runId,
          orgId,
          userId,
          creditsCharged: i + 1,
          status: "processed",
        });
      }),
    );

    const response = await GET(
      makeRequest({ range: "28d", groupBy: "source", tz: "UTC" }),
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as UsageInsightResponse;

    expect(data.schedules.length).toBe(100);
    expect(data.scheduleOtherCount).toBe(5);
  });

  it("scope isolation — other user's activity in same org is invisible", async () => {
    const { userId, orgId } = await context.user;
    const otherUserId = uniqueId("other-user");

    // Seed run for the main user
    const { composeId } = await seedTestCompose({
      userId,
      name: uniqueId("compose"),
      orgId,
    });
    const { runId: myRunId } = await seedTestRun(userId, composeId, {
      triggerSource: "web",
      status: "completed",
    });
    await insertTestCreditUsageForRun({
      runId: myRunId,
      orgId,
      userId,
      creditsCharged: 100,
      status: "processed",
    });

    // Seed run for the other user in the same org
    const { composeId: otherComposeId } = await seedTestCompose({
      userId: otherUserId,
      name: uniqueId("other-compose"),
      orgId,
    });
    const { runId: otherRunId } = await seedTestRun(
      otherUserId,
      otherComposeId,
      {
        triggerSource: "web",
        status: "completed",
      },
    );
    await insertTestCreditUsageForRun({
      runId: otherRunId,
      orgId,
      userId: otherUserId,
      creditsCharged: 999,
      status: "processed",
    });

    const response = await GET(
      makeRequest({ range: "7d", groupBy: "source", tz: "UTC" }),
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as UsageInsightResponse;

    // grandTotalCredits should only include the main user's 100 credits, not other user's 999
    expect(data.grandTotalCredits).toBe(100);
  });

  it("returns chat rows when groupBy=source and there are chat runs", async () => {
    const { userId, orgId } = await context.user;
    const { composeId } = await seedTestCompose({
      userId,
      name: uniqueId("compose"),
      orgId,
    });

    // Create a chat thread using the test seeder
    const threadId = await insertTestChatThread(
      userId,
      composeId,
      "Test Chat Thread",
    );

    // Create a run linked to the chat thread
    const { runId } = await seedTestRun(userId, composeId, {
      triggerSource: "web",
      chatThreadId: threadId,
      status: "completed",
    });

    await insertTestCreditUsageForRun({
      runId,
      orgId,
      userId,
      creditsCharged: 200,
      status: "processed",
    });

    const response = await GET(
      makeRequest({ range: "7d", groupBy: "source", tz: "UTC" }),
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as UsageInsightResponse;

    expect(data.chats.length).toBeGreaterThanOrEqual(1);
    const chat = data.chats.find((c) => {
      return c.threadId === threadId;
    });
    expect(chat).toBeDefined();
    expect(chat?.threadTitle).toBe("Test Chat Thread");
    expect(chat?.credits).toBe(200);
  });

  it("top-100 truncation — overflow with creditsCharged=0 still reports correct otherCount", async () => {
    const { userId, orgId } = await context.user;
    const { composeId } = await seedTestCompose({
      userId,
      name: uniqueId("compose"),
      orgId,
    });

    // Seed 105 schedules in parallel where the 5 overflow items have creditsCharged = 0
    await Promise.all(
      Array.from({ length: 105 }, async (_, i) => {
        const scheduleId = await seedTestSchedule({
          agentId: composeId,
          userId,
          orgId,
        });

        const { runId } = await seedTestRun(userId, composeId, {
          triggerSource: "schedule",
          scheduleId,
          status: "completed",
        });

        // Top-100 items have credits 6..105; overflow items 1..5 have creditsCharged = 0
        // so all overflow rows have zero credits — this is the regression case.
        await insertTestCreditUsageForRun({
          runId,
          orgId,
          userId,
          creditsCharged: i < 5 ? 0 : i + 1,
          status: "processed",
        });
      }),
    );

    const response = await GET(
      makeRequest({ range: "28d", groupBy: "source", tz: "UTC" }),
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as UsageInsightResponse;

    expect(data.schedules.length).toBe(100);
    expect(data.scheduleOtherCount).toBe(5);
  });
});
