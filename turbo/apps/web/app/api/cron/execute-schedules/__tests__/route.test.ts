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
import { reloadEnv } from "../../../../../src/env";

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
      reloadEnv();

      const request = createTestRequest(
        "http://localhost:3000/api/cron/execute-schedules",
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("should reject request with invalid CRON_SECRET", async () => {
      vi.stubEnv("CRON_SECRET", "correct-secret");
      reloadEnv();

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
    });

    it("should accept request with valid CRON_SECRET", async () => {
      vi.stubEnv("CRON_SECRET", "valid-secret");
      reloadEnv();

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
    });

    it("should reject request when CRON_SECRET is not configured", async () => {
      // Don't set CRON_SECRET - should reject for security
      const request = createTestRequest(
        "http://localhost:3000/api/cron/execute-schedules",
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });
  });

  describe("Execution", () => {
    it("should return success with execution counts", async () => {
      vi.stubEnv("CRON_SECRET", "test-secret");
      reloadEnv();

      const request = createTestRequest(
        "http://localhost:3000/api/cron/execute-schedules",
        {
          headers: { Authorization: "Bearer test-secret" },
        },
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(typeof data.executed).toBe("number");
      expect(typeof data.skipped).toBe("number");
    });

    it("should return execution counts", async () => {
      vi.stubEnv("CRON_SECRET", "test-secret");
      reloadEnv();

      // Create an enabled schedule with cron (won't be due immediately)
      await createTestSchedule(testComposeId, "cron-schedule", {
        cronExpression: "0 0 1 1 *", // Jan 1st at midnight - unlikely to be due
        prompt: "Test cron",
      });
      await enableTestSchedule(testComposeId, "cron-schedule");

      const request = createTestRequest(
        "http://localhost:3000/api/cron/execute-schedules",
        {
          headers: { Authorization: "Bearer test-secret" },
        },
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
    beforeEach(() => {
      vi.stubEnv("CRON_SECRET", "test-secret");
      reloadEnv();
    });

    function authenticatedCronRequest() {
      return createTestRequest(
        "http://localhost:3000/api/cron/execute-schedules",
        {
          headers: { Authorization: "Bearer test-secret" },
        },
      );
    }

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
      const response = await GET(authenticatedCronRequest());
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
      const response = await GET(authenticatedCronRequest());
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
      await GET(authenticatedCronRequest());

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

  describe("Loop Schedule Triggering", () => {
    beforeEach(() => {
      vi.stubEnv("CRON_SECRET", "test-secret");
      reloadEnv();
    });

    function authenticatedCronRequest() {
      return createTestRequest(
        "http://localhost:3000/api/cron/execute-schedules",
        {
          headers: { Authorization: "Bearer test-secret" },
        },
      );
    }

    it("should execute due loop schedule and set nextRunAt to null", async () => {
      // 1. Create and enable a loop schedule (nextRunAt = now on enable)
      await createTestSchedule(testComposeId, "loop-trigger-test", {
        intervalSeconds: 300,
        prompt: "Loop task",
      });
      await enableTestSchedule(testComposeId, "loop-trigger-test");

      // Verify it's enabled with nextRunAt set
      const before = await getTestSchedule(testComposeId, "loop-trigger-test");
      expect(before.enabled).toBe(true);
      expect(before.nextRunAt).not.toBeNull();

      // 2. Execute cron endpoint (loop schedule should be due immediately)
      const response = await GET(authenticatedCronRequest());
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.executed).toBeGreaterThanOrEqual(1);

      // 3. Verify loop schedule state after execution:
      //    - lastRunAt should be set
      //    - nextRunAt should be null (loop callback handles scheduling next run)
      const after = await getTestSchedule(testComposeId, "loop-trigger-test");
      expect(after.lastRunAt).not.toBeNull();
      expect(after.nextRunAt).toBeNull();
      expect(after.enabled).toBe(true);
    });

    it("should retry loop schedule when blocked by concurrency limit", async () => {
      // 1. Create and enable loop schedule
      await createTestSchedule(testComposeId, "loop-retry-test", {
        intervalSeconds: 300,
        prompt: "Loop retry task",
      });
      await enableTestSchedule(testComposeId, "loop-retry-test");

      // 2. Create a blocking run
      await createTestRun(testComposeId, "Blocking run");

      // 3. Execute cron - should fail due to concurrency limit
      await GET(authenticatedCronRequest());

      // 4. Verify schedule entered retry state
      const schedule = await getTestSchedule(testComposeId, "loop-retry-test");
      expect(schedule.retryStartedAt).not.toBeNull();
      expect(schedule.nextRunAt).not.toBeNull();
    });
  });

  describe("Concurrency Retry", () => {
    const cronSecret = "test-secret";

    beforeEach(() => {
      vi.stubEnv("CRON_SECRET", cronSecret);
      reloadEnv();
    });

    function authenticatedCronRequest() {
      return createTestRequest(
        "http://localhost:3000/api/cron/execute-schedules",
        {
          headers: { Authorization: `Bearer ${cronSecret}` },
        },
      );
    }

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
      const response = await GET(authenticatedCronRequest());
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
      await GET(authenticatedCronRequest());

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
      await GET(authenticatedCronRequest());

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
      await GET(authenticatedCronRequest());

      // Verify we're in retry state
      const midSchedule = await getTestSchedule(
        testComposeId,
        "retry-expire-test",
      );
      expect(midSchedule.retryStartedAt).not.toBeNull();

      // 5. Advance to 9:36 AM (35 minutes later - past 30-min retry window)
      context.mocks.date.setSystemTime(new Date("2025-01-15T09:36:00Z"));

      // 6. Execute cron - retry window should expire
      await GET(authenticatedCronRequest());

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
      await GET(authenticatedCronRequest());

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
      await GET(authenticatedCronRequest());

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
      await GET(authenticatedCronRequest());

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
      await GET(authenticatedCronRequest());

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
