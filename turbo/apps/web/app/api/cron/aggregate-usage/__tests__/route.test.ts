import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import {
  createTestCompose,
  createCompletedTestRun,
  findUsageDaily,
} from "../../../../../src/__tests__/api-test-helpers";
import { reloadEnv } from "../../../../../src/env";

vi.hoisted(() => {
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
});

const context = testContext();

function cronRequest(secret?: string) {
  return new Request("http://localhost:3000/api/cron/aggregate-usage", {
    method: "GET",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

function yesterdayDate(): { date: Date; dateStr: string } {
  const now = new Date();
  const date = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
  );
  date.setUTCHours(10, 0, 0, 0);
  return { date, dateStr: date.toISOString().split("T")[0]! };
}

describe("GET /api/cron/aggregate-usage", () => {
  let composeVersionId: string;
  let userId: string;

  beforeEach(async () => {
    context.setupMocks();
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    reloadEnv();
    const user = await context.setupUser();
    userId = user.userId;
    const { versionId } = await createTestCompose(uniqueId("usage-agent"));
    composeVersionId = versionId;
  });

  it("should return 401 with invalid cron secret", async () => {
    const response = await GET(cronRequest("wrong-secret"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 401 with missing authorization header", async () => {
    const response = await GET(cronRequest());
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 200 with no usage for current user", async () => {
    const response = await GET(cronRequest("test-cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.date).toBe(yesterdayDate().dateStr);

    const usage = await findUsageDaily(userId, yesterdayDate().dateStr);
    expect(usage).toBeUndefined();
  });

  it("should aggregate previous day completed runs", async () => {
    const { date, dateStr } = yesterdayDate();

    // Run 1: 5 seconds
    await createCompletedTestRun({
      composeVersionId,
      userId,
      createdAt: date,
      startedAt: date,
      completedAt: new Date(date.getTime() + 5000),
    });

    // Run 2: 8 seconds (1 min after run 1)
    const run2Start = new Date(date.getTime() + 60000);
    await createCompletedTestRun({
      composeVersionId,
      userId,
      createdAt: run2Start,
      startedAt: run2Start,
      completedAt: new Date(run2Start.getTime() + 8000),
    });

    const response = await GET(cronRequest("test-cron-secret"));
    expect(response.status).toBe(200);

    const usage = await findUsageDaily(userId, dateStr);
    expect(usage).toBeDefined();
    expect(usage!.runCount).toBe(2);
    expect(usage!.runTimeMs).toBe(13000);
  });

  it("should be idempotent on rerun", async () => {
    const { date, dateStr } = yesterdayDate();

    await createCompletedTestRun({
      composeVersionId,
      userId,
      createdAt: date,
      startedAt: date,
      completedAt: new Date(date.getTime() + 5000),
    });

    // First run
    await GET(cronRequest("test-cron-secret"));

    // Second run
    const response = await GET(cronRequest("test-cron-secret"));
    expect(response.status).toBe(200);

    const usage = await findUsageDaily(userId, dateStr);
    expect(usage!.runCount).toBe(1);
    expect(usage!.runTimeMs).toBe(5000);
  });
});
