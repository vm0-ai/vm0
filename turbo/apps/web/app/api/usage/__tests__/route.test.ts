import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  completeTestRun,
  findUsageDaily,
} from "../../../../src/__tests__/api-test-helpers";
import { seedCompletedTestRun } from "../../../../src/__tests__/db-test-seeders/runs";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("GET /api/usage", () => {
  let user: UserContext;
  let testComposeId: string;
  let testVersionId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId, versionId } = await createTestCompose(uniqueId("usage"));
    testComposeId = composeId;
    testVersionId = versionId;
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest("http://localhost:3000/api/usage");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should return usage data with default 7 day range", async () => {
    // Create and complete two runs
    const { runId: runId1 } = await createTestRun(
      testComposeId,
      "Test prompt 1",
    );
    await completeTestRun(user.userId, runId1);

    const { runId: runId2 } = await createTestRun(
      testComposeId,
      "Test prompt 2",
    );
    await completeTestRun(user.userId, runId2);

    const request = createTestRequest("http://localhost:3000/api/usage");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.period).toBeDefined();
    expect(data.period.start).toBeDefined();
    expect(data.period.end).toBeDefined();
    expect(data.summary).toBeDefined();
    expect(data.summary.total_runs).toBe(2);
    expect(data.daily).toBeDefined();
    expect(Array.isArray(data.daily)).toBe(true);
    expect(data.daily.length).toBeGreaterThan(0);
  });

  it("should accept custom date range", async () => {
    const now = new Date();
    const threeDaysAgo = new Date(now);
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

    const request = createTestRequest(
      `http://localhost:3000/api/usage?start_date=${threeDaysAgo.toISOString()}&end_date=${now.toISOString()}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.period.start).toBeDefined();
    expect(data.period.end).toBeDefined();
  });

  it("should reject invalid start_date format", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/usage?start_date=invalid",
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("Invalid start_date format");
  });

  it("should reject invalid end_date format", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/usage?end_date=invalid",
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("Invalid end_date format");
  });

  it("should reject start_date after end_date", async () => {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);

    const request = createTestRequest(
      `http://localhost:3000/api/usage?start_date=${now.toISOString()}&end_date=${yesterday.toISOString()}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("start_date must be before end_date");
  });

  it("should reject range exceeding 30 days", async () => {
    const now = new Date();
    const fortyDaysAgo = new Date(now);
    fortyDaysAgo.setDate(fortyDaysAgo.getDate() - 40);

    const request = createTestRequest(
      `http://localhost:3000/api/usage?start_date=${fortyDaysAgo.toISOString()}&end_date=${now.toISOString()}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("exceeds maximum of 30 days");
  });

  it("should return daily breakdown with run counts and run times", async () => {
    // Create and complete multiple runs to verify daily aggregation
    const { runId: runId1 } = await createTestRun(testComposeId, "Prompt 1");
    await completeTestRun(user.userId, runId1);

    const { runId: runId2 } = await createTestRun(testComposeId, "Prompt 2");
    await completeTestRun(user.userId, runId2);

    const request = createTestRequest("http://localhost:3000/api/usage");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.daily.length).toBeGreaterThan(0);

    // Check that daily data has expected structure
    for (const day of data.daily) {
      expect(day.date).toBeDefined();
      expect(typeof day.run_count).toBe("number");
      expect(typeof day.run_time_ms).toBe("number");
    }

    // Verify summary totals
    expect(data.summary.total_runs).toBe(2);
    expect(typeof data.summary.total_run_time_ms).toBe("number");
  });

  it("should calculate run times correctly with explicit timestamps", async () => {
    // Use seedCompletedTestRun to insert runs with explicit startedAt/completedAt.
    // Runs created via createTestRun have startedAt=null (set later by runner claim),
    // so we must insert directly to test run_time_ms calculation.

    const now = new Date();

    // Run 1: 1 minute duration
    const startTime1 = new Date(now.getTime() - 3600000); // 1 hour ago
    await seedCompletedTestRun({
      composeVersionId: testVersionId,
      userId: user.userId,
      createdAt: startTime1,
      startedAt: startTime1,
      completedAt: new Date(startTime1.getTime() + 60 * 1000),
    });

    // Run 2: 2 minute duration
    const startTime2 = new Date(now.getTime() - 1800000); // 30 min ago
    await seedCompletedTestRun({
      composeVersionId: testVersionId,
      userId: user.userId,
      createdAt: startTime2,
      startedAt: startTime2,
      completedAt: new Date(startTime2.getTime() + 2 * 60 * 1000),
    });

    const request = createTestRequest("http://localhost:3000/api/usage");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.summary.total_runs).toBe(2);
    // Run 1: 60000ms (1 min) + Run 2: 120000ms (2 min) = 180000ms
    expect(data.summary.total_run_time_ms).toBe(180000);
  });

  describe("on-demand aggregation", () => {
    let composeVersionId: string;

    beforeEach(async () => {
      const { versionId } = await createTestCompose(uniqueId("ondemand"));
      composeVersionId = versionId;
    });

    it("should aggregate historical runs across multiple days", async () => {
      const now = new Date();
      const fiveDaysAgo = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 5),
      );
      const threeDaysAgo = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 3),
      );
      const fourDaysAgo = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 4),
      );

      // Create runs on 2 different historical days
      const day1Run = new Date(fourDaysAgo.getTime() + 10 * 3600000);
      await seedCompletedTestRun({
        composeVersionId,
        userId: user.userId,
        createdAt: day1Run,
        startedAt: day1Run,
        completedAt: new Date(day1Run.getTime() + 5000),
      });

      const day2Run = new Date(threeDaysAgo.getTime() + 10 * 3600000);
      await seedCompletedTestRun({
        composeVersionId,
        userId: user.userId,
        createdAt: day2Run,
        startedAt: day2Run,
        completedAt: new Date(day2Run.getTime() + 8000),
      });

      const request = createTestRequest(
        `http://localhost:3000/api/usage?start_date=${fiveDaysAgo.toISOString()}&end_date=${now.toISOString()}`,
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.summary.total_runs).toBe(2);
      expect(data.summary.total_run_time_ms).toBe(13000);
      expect(data.daily.length).toBe(2);
    });

    it("should use agent_runs for partial start day boundary", async () => {
      const now = new Date();
      const twoDaysAgo = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2),
      );

      // Create a run 2 days ago at 14:00
      const partialDayStart = new Date(twoDaysAgo.getTime() + 14 * 3600000);
      await seedCompletedTestRun({
        composeVersionId,
        userId: user.userId,
        createdAt: partialDayStart,
        startedAt: partialDayStart,
        completedAt: new Date(partialDayStart.getTime() + 5000),
      });

      // Create another run 2 days ago at 08:00 (before partial boundary)
      const earlyRun = new Date(twoDaysAgo.getTime() + 8 * 3600000);
      await seedCompletedTestRun({
        composeVersionId,
        userId: user.userId,
        createdAt: earlyRun,
        startedAt: earlyRun,
        completedAt: new Date(earlyRun.getTime() + 3000),
      });

      // Query starting at 14:00 — only the 14:00 run should be counted
      const request = createTestRequest(
        `http://localhost:3000/api/usage?start_date=${partialDayStart.toISOString()}&end_date=${now.toISOString()}`,
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);

      const twoDaysAgoStr = twoDaysAgo.toISOString().split("T")[0]!;
      const partialDay = data.daily.find((d: { date: string }) => {
        return d.date === twoDaysAgoStr;
      });
      expect(partialDay).toBeDefined();
      expect(partialDay.run_count).toBe(1);
      expect(partialDay.run_time_ms).toBe(5000);
    });

    it("should cache computed results for subsequent queries", async () => {
      const now = new Date();
      const fourDaysAgo = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 4),
      );
      const fiveDaysAgo = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 5),
      );

      const runTime = new Date(fourDaysAgo.getTime() + 10 * 3600000);
      await seedCompletedTestRun({
        composeVersionId,
        userId: user.userId,
        createdAt: runTime,
        startedAt: runTime,
        completedAt: new Date(runTime.getTime() + 6000),
      });

      const url = `http://localhost:3000/api/usage?start_date=${fiveDaysAgo.toISOString()}&end_date=${now.toISOString()}`;

      // First query: triggers on-demand compute + cache write
      const response1 = await GET(createTestRequest(url));
      const data1 = await response1.json();

      expect(data1.summary.total_runs).toBe(1);
      expect(data1.summary.total_run_time_ms).toBe(6000);

      // Verify cache was written to usage_daily
      const fourDaysAgoStr = fourDaysAgo.toISOString().split("T")[0]!;
      const cached = await findUsageDaily(
        user.userId,
        user.orgId,
        fourDaysAgoStr,
      );
      expect(cached).toBeDefined();
      expect(cached!.runCount).toBe(1);
      expect(cached!.runTimeMs).toBe(6000);

      // Second query returns same result (now from cache)
      const response2 = await GET(createTestRequest(url));
      const data2 = await response2.json();
      expect(data2.summary.total_runs).toBe(data1.summary.total_runs);
      expect(data2.summary.total_run_time_ms).toBe(
        data1.summary.total_run_time_ms,
      );
    });
  });

  describe("org isolation", () => {
    it("should only return usage for the resolved org", async () => {
      const now = new Date();
      const runTime = new Date(now.getTime() - 3600000);

      // Create run in default user's org
      await seedCompletedTestRun({
        composeVersionId: testVersionId,
        userId: user.userId,
        createdAt: runTime,
        startedAt: runTime,
        completedAt: new Date(runTime.getTime() + 5000),
      });

      // Create a second user with a different org, create a compose + run there
      const otherUser = await context.setupUser({ prefix: "other-user" });
      mockClerk({ userId: otherUser.userId, orgId: otherUser.orgId });
      const { versionId: otherVersionId } = await createTestCompose(
        uniqueId("other-usage"),
      );
      await seedCompletedTestRun({
        composeVersionId: otherVersionId,
        userId: otherUser.userId,
        createdAt: runTime,
        startedAt: runTime,
        completedAt: new Date(runTime.getTime() + 8000),
      });

      // Switch back to original user
      mockClerk({ userId: user.userId, orgId: user.orgId });

      // Query with default org context — should only see the original user's org run
      const request = createTestRequest("http://localhost:3000/api/usage");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.summary.total_runs).toBe(1);
      expect(data.summary.total_run_time_ms).toBe(5000);
    });
  });
});
