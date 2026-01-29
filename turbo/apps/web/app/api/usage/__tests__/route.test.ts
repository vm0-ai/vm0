import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  completeTestRun,
} from "../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

describe("GET /api/usage", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(`usage-${Date.now()}`);
    testComposeId = composeId;
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

  it("should calculate run times correctly with mocked dates", async () => {
    // Note: createdAt is set by PostgreSQL defaultNow() and cannot be mocked.
    // We mock startedAt/completedAt to test run_time_ms calculation.
    // startedAt is set during createTestRun, completedAt during completeTestRun.

    // Run 1: mock time before creating run (startedAt), then advance for completion
    const startTime1 = new Date("2024-06-13T12:00:00.000Z");
    context.mocks.date.setSystemTime(startTime1);
    const { runId: runId1 } = await createTestRun(testComposeId, "Prompt 1");

    // Advance time by 1 minute before completing
    context.mocks.date.setSystemTime(
      new Date(startTime1.getTime() + 60 * 1000),
    );
    await completeTestRun(user.userId, runId1);

    // Run 2: same pattern - mock time, create, advance, complete
    const startTime2 = new Date("2024-06-12T12:00:00.000Z");
    context.mocks.date.setSystemTime(startTime2);
    const { runId: runId2 } = await createTestRun(testComposeId, "Prompt 2");

    // Advance time by 2 minutes before completing
    context.mocks.date.setSystemTime(
      new Date(startTime2.getTime() + 2 * 60 * 1000),
    );
    await completeTestRun(user.userId, runId2);

    // Restore real time and query with default range (uses real createdAt)
    context.mocks.date.useRealTime();

    const request = createTestRequest("http://localhost:3000/api/usage");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.summary.total_runs).toBe(2);
    // Run 1: 60000ms (1 min) + Run 2: 120000ms (2 min) = 180000ms
    expect(data.summary.total_run_time_ms).toBe(180000);
  });
});
