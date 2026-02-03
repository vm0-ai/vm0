import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  createTestSchedule,
  enableTestSchedule,
  getTestSchedule,
  getTestScheduleRuns,
  completeTestRun,
} from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

describe("GET /api/cron/execute-schedules", () => {
  let testComposeId: string;
  let testUserId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    testUserId = user.userId;

    const { composeId } = await createTestCompose(
      `cron-test-agent-${Date.now()}`,
    );
    testComposeId = composeId;
  });

  describe("Authorization", () => {
    it("should reject request without CRON_SECRET header when secret is set", async () => {
      vi.stubEnv("CRON_SECRET", "test-cron-secret");

      try {
        const request = createTestRequest(
          "http://localhost:3000/api/cron/execute-schedules",
        );

        const response = await GET(request);
        const data = await response.json();

        expect(response.status).toBe(401);
        expect(data.error.code).toBe("UNAUTHORIZED");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("should reject request with invalid CRON_SECRET", async () => {
      vi.stubEnv("CRON_SECRET", "correct-secret");

      try {
        const request = createTestRequest(
          "http://localhost:3000/api/cron/execute-schedules",
          {
            headers: { Authorization: "Bearer wrong-secret" },
          },
        );

        const response = await GET(request);
        const data = await response.json();

        expect(response.status).toBe(401);
        expect(data.error.code).toBe("UNAUTHORIZED");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("should accept request with valid CRON_SECRET", async () => {
      vi.stubEnv("CRON_SECRET", "valid-secret");

      try {
        const request = createTestRequest(
          "http://localhost:3000/api/cron/execute-schedules",
          {
            headers: { Authorization: "Bearer valid-secret" },
          },
        );

        const response = await GET(request);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.success).toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("should allow request when CRON_SECRET is not configured", async () => {
      // Don't set CRON_SECRET - allows any request (dev mode)
      const request = createTestRequest(
        "http://localhost:3000/api/cron/execute-schedules",
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });
  });

  describe("Execution", () => {
    it("should return success with execution counts", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/cron/execute-schedules",
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(typeof data.executed).toBe("number");
      expect(typeof data.skipped).toBe("number");
    });

    it("should return execution counts", async () => {
      // Create an enabled schedule with cron (won't be due immediately)
      await createTestSchedule(testComposeId, "cron-schedule", {
        cronExpression: "0 0 1 1 *", // Jan 1st at midnight - unlikely to be due
        prompt: "Test cron",
      });
      await enableTestSchedule(testComposeId, "cron-schedule");

      const request = createTestRequest(
        "http://localhost:3000/api/cron/execute-schedules",
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(typeof data.executed).toBe("number");
      expect(typeof data.skipped).toBe("number");
    });
  });

  describe("Schedule Triggering", () => {
    it("should execute due cron schedule", async () => {
      // 1. Mock time to 8:00 AM UTC
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:00:00Z"));

      // 2. Create schedule with cron for 9 AM - nextRunAt will be calculated as 9 AM today
      await createTestSchedule(testComposeId, "cron-trigger-test", {
        cronExpression: "0 9 * * *",
        prompt: "Daily 9 AM task",
        timezone: "UTC",
      });
      await enableTestSchedule(testComposeId, "cron-trigger-test");

      // 3. Advance time to 9:01 AM (schedule is now due)
      context.mocks.date.setSystemTime(new Date("2025-01-15T09:01:00Z"));

      // 4. Execute cron endpoint
      const request = createTestRequest(
        "http://localhost:3000/api/cron/execute-schedules",
      );
      const response = await GET(request);
      const data = await response.json();

      // 5. Assert schedule was executed
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.executed).toBeGreaterThanOrEqual(1);

      // 6. Verify the schedule was actually executed by checking lastRunAt
      const schedule = await getTestSchedule(
        testComposeId,
        "cron-trigger-test",
      );
      expect(schedule.lastRunAt).not.toBeNull();
    });

    it("should execute due one-time (atTime) schedule", async () => {
      // 1. Mock time to 8:00 AM UTC
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:00:00Z"));

      // 2. Create one-time schedule for 9:00 AM
      await createTestSchedule(testComposeId, "onetime-trigger-test", {
        atTime: "2025-01-15T09:00:00Z",
        prompt: "One-time task",
        timezone: "UTC",
      });
      await enableTestSchedule(testComposeId, "onetime-trigger-test");

      // 3. Advance time to 9:01 AM UTC (schedule is now due)
      context.mocks.date.setSystemTime(new Date("2025-01-15T09:01:00Z"));

      // 4. Execute cron endpoint
      const request = createTestRequest(
        "http://localhost:3000/api/cron/execute-schedules",
      );
      const response = await GET(request);
      const data = await response.json();

      // 5. Assert schedule was executed
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.executed).toBeGreaterThanOrEqual(1);
    });

    it("should disable one-time schedule after execution", async () => {
      // 1. Mock time to 8:00 AM UTC
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:00:00Z"));

      // 2. Create and enable one-time schedule
      await createTestSchedule(testComposeId, "onetime-disable-test", {
        atTime: "2025-01-15T09:00:00Z",
        prompt: "One-time task",
        timezone: "UTC",
      });
      await enableTestSchedule(testComposeId, "onetime-disable-test");

      // Verify it's enabled
      const beforeSchedule = await getTestSchedule(
        testComposeId,
        "onetime-disable-test",
      );
      expect(beforeSchedule.enabled).toBe(true);

      // 3. Advance time past the scheduled time
      context.mocks.date.setSystemTime(new Date("2025-01-15T09:01:00Z"));

      // 4. Execute cron
      const request = createTestRequest(
        "http://localhost:3000/api/cron/execute-schedules",
      );
      await GET(request);

      // 5. Verify schedule was disabled after execution
      const afterSchedule = await getTestSchedule(
        testComposeId,
        "onetime-disable-test",
      );
      expect(afterSchedule.enabled).toBe(false);
      expect(afterSchedule.nextRunAt).toBeNull();
      expect(afterSchedule.lastRunAt).not.toBeNull();
    });
  });

  describe("Concurrency Retry", () => {
    it("should retry schedule when blocked by concurrency limit", async () => {
      // 1. Set time to 8:00 AM
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:00:00Z"));

      // 2. Create and enable schedule for 9 AM
      await createTestSchedule(testComposeId, "retry-test", {
        cronExpression: "0 9 * * *",
        prompt: "Daily task",
        timezone: "UTC",
      });
      await enableTestSchedule(testComposeId, "retry-test");

      // 3. Create a pending run to block concurrency (default limit is 1)
      await createTestRun(testComposeId, "Blocking run");

      // 4. Advance time to 9:01 AM (schedule is due)
      context.mocks.date.setSystemTime(new Date("2025-01-15T09:01:00Z"));

      // 5. Execute cron - should fail due to concurrency limit
      const request = createTestRequest(
        "http://localhost:3000/api/cron/execute-schedules",
      );
      const response = await GET(request);
      expect(response.status).toBe(200);

      // 6. Verify schedule entered retry state
      const schedule = await getTestSchedule(testComposeId, "retry-test");
      expect(schedule.retryStartedAt).not.toBeNull();
      // nextRunAt should be 5 minutes later, not tomorrow 9 AM
      const nextRunAt = new Date(schedule.nextRunAt!);
      const expectedRetryAt = new Date("2025-01-15T09:06:00Z");
      expect(nextRunAt.getTime()).toBe(expectedRetryAt.getTime());

      // 7. Verify a failed run was created
      const { runs } = await getTestScheduleRuns(
        testComposeId,
        "retry-test",
        1,
      );
      expect(runs.length).toBe(1);
      expect(runs[0]?.status).toBe("failed");
      expect(runs[0]?.error).toContain("concurrent");
    });

    it("should preserve retryStartedAt on subsequent retries", async () => {
      // 1. Set time to 8:00 AM
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:00:00Z"));

      // 2. Create and enable schedule for 9 AM
      await createTestSchedule(testComposeId, "retry-preserve-test", {
        cronExpression: "0 9 * * *",
        prompt: "Daily task",
        timezone: "UTC",
      });
      await enableTestSchedule(testComposeId, "retry-preserve-test");

      // 3. Create a blocking run
      await createTestRun(testComposeId, "Blocking run");

      // 4. Advance to 9:01 AM and trigger first retry
      context.mocks.date.setSystemTime(new Date("2025-01-15T09:01:00Z"));
      await GET(
        createTestRequest("http://localhost:3000/api/cron/execute-schedules"),
      );

      // 5. Record the initial retryStartedAt
      const firstSchedule = await getTestSchedule(
        testComposeId,
        "retry-preserve-test",
      );
      const initialRetryStartedAt = firstSchedule.retryStartedAt;
      expect(initialRetryStartedAt).not.toBeNull();

      // 6. Advance to 9:06 AM (5 minutes later - retry time)
      context.mocks.date.setSystemTime(new Date("2025-01-15T09:06:00Z"));

      // 7. Execute cron again (second retry attempt)
      await GET(
        createTestRequest("http://localhost:3000/api/cron/execute-schedules"),
      );

      // 8. Verify retryStartedAt was preserved
      const secondSchedule = await getTestSchedule(
        testComposeId,
        "retry-preserve-test",
      );
      expect(secondSchedule.retryStartedAt).toBe(initialRetryStartedAt);
    });

    it("should advance to next occurrence when retry window expires", async () => {
      // 1. Set time to 8:00 AM
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:00:00Z"));

      // 2. Create and enable schedule for 9 AM
      await createTestSchedule(testComposeId, "retry-expire-test", {
        cronExpression: "0 9 * * *",
        prompt: "Daily task",
        timezone: "UTC",
      });
      await enableTestSchedule(testComposeId, "retry-expire-test");

      // 3. Create a blocking run
      await createTestRun(testComposeId, "Blocking run");

      // 4. Advance to 9:01 AM and trigger first retry
      context.mocks.date.setSystemTime(new Date("2025-01-15T09:01:00Z"));
      await GET(
        createTestRequest("http://localhost:3000/api/cron/execute-schedules"),
      );

      // Verify we're in retry state
      const midSchedule = await getTestSchedule(
        testComposeId,
        "retry-expire-test",
      );
      expect(midSchedule.retryStartedAt).not.toBeNull();

      // 5. Advance to 9:36 AM (35 minutes later - past 30-min retry window)
      context.mocks.date.setSystemTime(new Date("2025-01-15T09:36:00Z"));

      // 6. Execute cron - retry window should expire
      await GET(
        createTestRequest("http://localhost:3000/api/cron/execute-schedules"),
      );

      // 7. Verify schedule advanced to next day (tomorrow 9 AM)
      const finalSchedule = await getTestSchedule(
        testComposeId,
        "retry-expire-test",
      );
      expect(finalSchedule.retryStartedAt).toBeNull();
      const nextRunAt = new Date(finalSchedule.nextRunAt!);
      expect(nextRunAt.toISOString()).toBe("2025-01-16T09:00:00.000Z");
    });

    it("should clear retryStartedAt on successful execution", async () => {
      // 1. Set time to 8:00 AM
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:00:00Z"));

      // 2. Create and enable schedule for 9 AM
      await createTestSchedule(testComposeId, "retry-clear-test", {
        cronExpression: "0 9 * * *",
        prompt: "Daily task",
        timezone: "UTC",
      });
      await enableTestSchedule(testComposeId, "retry-clear-test");

      // 3. Create a blocking run
      const { runId: blockingRunId } = await createTestRun(
        testComposeId,
        "Blocking run",
      );

      // 4. Advance to 9:01 AM and trigger first retry
      context.mocks.date.setSystemTime(new Date("2025-01-15T09:01:00Z"));
      await GET(
        createTestRequest("http://localhost:3000/api/cron/execute-schedules"),
      );

      // Verify we're in retry state
      const midSchedule = await getTestSchedule(
        testComposeId,
        "retry-clear-test",
      );
      expect(midSchedule.retryStartedAt).not.toBeNull();

      // 5. Complete the blocking run to free up concurrency
      await completeTestRun(testUserId, blockingRunId);

      // 6. Advance to 9:06 AM (retry time) and execute
      context.mocks.date.setSystemTime(new Date("2025-01-15T09:06:00Z"));
      await GET(
        createTestRequest("http://localhost:3000/api/cron/execute-schedules"),
      );

      // 7. Verify retryStartedAt was cleared and execution succeeded
      const finalSchedule = await getTestSchedule(
        testComposeId,
        "retry-clear-test",
      );
      expect(finalSchedule.retryStartedAt).toBeNull();
      expect(finalSchedule.lastRunAt).not.toBeNull();
    });

    it("should disable one-time schedule after retry window expires", async () => {
      // 1. Set time to 8:00 AM
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:00:00Z"));

      // 2. Create and enable one-time schedule for 9:00 AM
      await createTestSchedule(testComposeId, "onetime-retry-expire", {
        atTime: "2025-01-15T09:00:00Z",
        prompt: "One-time task",
        timezone: "UTC",
      });
      await enableTestSchedule(testComposeId, "onetime-retry-expire");

      // 3. Create a blocking run
      await createTestRun(testComposeId, "Blocking run");

      // 4. Advance to 9:01 AM and trigger first retry
      context.mocks.date.setSystemTime(new Date("2025-01-15T09:01:00Z"));
      await GET(
        createTestRequest("http://localhost:3000/api/cron/execute-schedules"),
      );

      // Verify we're in retry state
      const midSchedule = await getTestSchedule(
        testComposeId,
        "onetime-retry-expire",
      );
      expect(midSchedule.retryStartedAt).not.toBeNull();
      expect(midSchedule.enabled).toBe(true);

      // 5. Advance to 9:36 AM (35 minutes later - past 30-min retry window)
      context.mocks.date.setSystemTime(new Date("2025-01-15T09:36:00Z"));

      // 6. Execute cron - retry window should expire
      await GET(
        createTestRequest("http://localhost:3000/api/cron/execute-schedules"),
      );

      // 7. Verify one-time schedule was disabled
      const finalSchedule = await getTestSchedule(
        testComposeId,
        "onetime-retry-expire",
      );
      expect(finalSchedule.enabled).toBe(false);
      expect(finalSchedule.nextRunAt).toBeNull();
      expect(finalSchedule.retryStartedAt).toBeNull();
    });
  });
});
