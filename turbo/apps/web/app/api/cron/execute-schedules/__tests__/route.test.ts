import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestSchedule,
  enableTestSchedule,
  getTestSchedule,
  getTestScheduleRuns,
  setScheduleRetryStartedAt,
} from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { ConcurrentRunLimitError } from "../../../../../src/lib/errors";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

describe("GET /api/cron/execute-schedules", () => {
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();

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
      // 1. Mock time to 8:00 AM UTC
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:00:00Z"));

      // 2. Create and enable schedule for 9 AM
      await createTestSchedule(testComposeId, "retry-test", {
        cronExpression: "0 9 * * *",
        prompt: "Daily task",
        timezone: "UTC",
      });
      await enableTestSchedule(testComposeId, "retry-test");

      // 3. Advance time to 9:01 AM (schedule is due)
      context.mocks.date.setSystemTime(new Date("2025-01-15T09:01:00Z"));

      // 4. Mock checkRunConcurrencyLimit to throw ConcurrentRunLimitError
      const runService = await import("../../../../../src/lib/run/run-service");
      const checkSpy = vi
        .spyOn(runService, "checkRunConcurrencyLimit")
        .mockRejectedValueOnce(
          new ConcurrentRunLimitError("Concurrent run limit reached"),
        );

      try {
        // 5. Execute cron
        const request = createTestRequest(
          "http://localhost:3000/api/cron/execute-schedules",
        );
        const response = await GET(request);
        expect(response.status).toBe(200);

        // 6. Verify schedule was NOT advanced to tomorrow but retries in 5 minutes
        const schedule = await getTestSchedule(testComposeId, "retry-test");
        expect(schedule.retryStartedAt).not.toBeNull();
        // nextRunAt should be ~5 minutes from now, not tomorrow 9 AM
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
        expect(runs[0]?.error).toContain("Concurrent run limit");
      } finally {
        checkSpy.mockRestore();
      }
    });

    it("should preserve retryStartedAt on subsequent retries", async () => {
      // 1. Mock time to 9:01 AM
      context.mocks.date.setSystemTime(new Date("2025-01-15T09:01:00Z"));

      // 2. Create schedule and enable it
      await createTestSchedule(testComposeId, "retry-preserve-test", {
        cronExpression: "0 9 * * *",
        prompt: "Daily task",
        timezone: "UTC",
      });
      const schedule = await enableTestSchedule(
        testComposeId,
        "retry-preserve-test",
      );

      // 3. Set retryStartedAt to 10 minutes ago (simulating we're already in retry)
      const retryStart = new Date("2025-01-15T08:51:00Z");
      await setScheduleRetryStartedAt(schedule.id, retryStart);

      // 4. Set nextRunAt to now (simulating a retry attempt)
      const { agentSchedules } = await import(
        "../../../../../src/db/schema/agent-schedule"
      );
      const { eq } = await import("drizzle-orm");
      await globalThis.services.db
        .update(agentSchedules)
        .set({ nextRunAt: new Date("2025-01-15T09:01:00Z") })
        .where(eq(agentSchedules.id, schedule.id));

      // 5. Mock concurrency limit failure again
      const runService = await import("../../../../../src/lib/run/run-service");
      const checkSpy = vi
        .spyOn(runService, "checkRunConcurrencyLimit")
        .mockRejectedValueOnce(
          new ConcurrentRunLimitError("Concurrent run limit reached"),
        );

      try {
        // 6. Execute cron
        const request = createTestRequest(
          "http://localhost:3000/api/cron/execute-schedules",
        );
        await GET(request);

        // 7. Verify retryStartedAt was preserved (not reset to now)
        const updatedSchedule = await getTestSchedule(
          testComposeId,
          "retry-preserve-test",
        );
        expect(new Date(updatedSchedule.retryStartedAt!).getTime()).toBe(
          retryStart.getTime(),
        );
      } finally {
        checkSpy.mockRestore();
      }
    });

    it("should advance to next occurrence when retry window expires", async () => {
      // 1. Mock time to 9:01 AM
      context.mocks.date.setSystemTime(new Date("2025-01-15T09:01:00Z"));

      // 2. Create and enable schedule
      await createTestSchedule(testComposeId, "retry-expire-test", {
        cronExpression: "0 9 * * *",
        prompt: "Daily task",
        timezone: "UTC",
      });
      const schedule = await enableTestSchedule(
        testComposeId,
        "retry-expire-test",
      );

      // 3. Set retryStartedAt to 35 minutes ago (past the 30-min window)
      const retryStart = new Date("2025-01-15T08:26:00Z");
      await setScheduleRetryStartedAt(schedule.id, retryStart);

      // 4. Set nextRunAt to now
      const { agentSchedules } = await import(
        "../../../../../src/db/schema/agent-schedule"
      );
      const { eq } = await import("drizzle-orm");
      await globalThis.services.db
        .update(agentSchedules)
        .set({ nextRunAt: new Date("2025-01-15T09:01:00Z") })
        .where(eq(agentSchedules.id, schedule.id));

      // 5. Mock concurrency limit failure
      const runService = await import("../../../../../src/lib/run/run-service");
      const checkSpy = vi
        .spyOn(runService, "checkRunConcurrencyLimit")
        .mockRejectedValueOnce(
          new ConcurrentRunLimitError("Concurrent run limit reached"),
        );

      try {
        // 6. Execute cron
        const request = createTestRequest(
          "http://localhost:3000/api/cron/execute-schedules",
        );
        await GET(request);

        // 7. Verify schedule advanced to next day (tomorrow 9 AM)
        const updatedSchedule = await getTestSchedule(
          testComposeId,
          "retry-expire-test",
        );
        // retryStartedAt should be cleared
        expect(updatedSchedule.retryStartedAt).toBeNull();
        // nextRunAt should be tomorrow 9 AM
        const nextRunAt = new Date(updatedSchedule.nextRunAt!);
        expect(nextRunAt.toISOString()).toBe("2025-01-16T09:00:00.000Z");
      } finally {
        checkSpy.mockRestore();
      }
    });

    it("should clear retryStartedAt on successful execution", async () => {
      // 1. Mock time to 9:01 AM
      context.mocks.date.setSystemTime(new Date("2025-01-15T09:01:00Z"));

      // 2. Create and enable schedule
      await createTestSchedule(testComposeId, "retry-clear-test", {
        cronExpression: "0 9 * * *",
        prompt: "Daily task",
        timezone: "UTC",
      });
      const schedule = await enableTestSchedule(
        testComposeId,
        "retry-clear-test",
      );

      // 3. Set retryStartedAt (simulating previous failed attempt)
      await setScheduleRetryStartedAt(
        schedule.id,
        new Date("2025-01-15T08:51:00Z"),
      );

      // 4. Set nextRunAt to now
      const { agentSchedules } = await import(
        "../../../../../src/db/schema/agent-schedule"
      );
      const { eq } = await import("drizzle-orm");
      await globalThis.services.db
        .update(agentSchedules)
        .set({ nextRunAt: new Date("2025-01-15T09:01:00Z") })
        .where(eq(agentSchedules.id, schedule.id));

      // 5. Execute cron (no mock = success)
      const request = createTestRequest(
        "http://localhost:3000/api/cron/execute-schedules",
      );
      await GET(request);

      // 6. Verify retryStartedAt was cleared
      const updatedSchedule = await getTestSchedule(
        testComposeId,
        "retry-clear-test",
      );
      expect(updatedSchedule.retryStartedAt).toBeNull();
      expect(updatedSchedule.lastRunAt).not.toBeNull();
    });

    it("should disable one-time schedule after retry window expires", async () => {
      // 1. Mock time to 8:00 AM (before the schedule time)
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:00:00Z"));

      // 2. Create and enable one-time schedule for 9:00 AM
      await createTestSchedule(testComposeId, "onetime-retry-expire", {
        atTime: "2025-01-15T09:00:00Z",
        prompt: "One-time task",
        timezone: "UTC",
      });
      const schedule = await enableTestSchedule(
        testComposeId,
        "onetime-retry-expire",
      );

      // 3. Advance time to 9:01 AM (schedule is due)
      context.mocks.date.setSystemTime(new Date("2025-01-15T09:01:00Z"));

      // 4. Set retryStartedAt to 35 minutes ago (past the 30-min window)
      await setScheduleRetryStartedAt(
        schedule.id,
        new Date("2025-01-15T08:26:00Z"),
      );

      // 5. Set nextRunAt to now (simulating a retry attempt)
      const { agentSchedules } = await import(
        "../../../../../src/db/schema/agent-schedule"
      );
      const { eq } = await import("drizzle-orm");
      await globalThis.services.db
        .update(agentSchedules)
        .set({ nextRunAt: new Date("2025-01-15T09:01:00Z") })
        .where(eq(agentSchedules.id, schedule.id));

      // 6. Mock concurrency limit failure
      const runService = await import("../../../../../src/lib/run/run-service");
      const checkSpy = vi
        .spyOn(runService, "checkRunConcurrencyLimit")
        .mockRejectedValueOnce(
          new ConcurrentRunLimitError("Concurrent run limit reached"),
        );

      try {
        // 7. Execute cron
        const request = createTestRequest(
          "http://localhost:3000/api/cron/execute-schedules",
        );
        await GET(request);

        // 8. Verify one-time schedule was disabled
        const updatedSchedule = await getTestSchedule(
          testComposeId,
          "onetime-retry-expire",
        );
        expect(updatedSchedule.enabled).toBe(false);
        expect(updatedSchedule.nextRunAt).toBeNull();
        expect(updatedSchedule.retryStartedAt).toBeNull();
      } finally {
        checkSpy.mockRestore();
      }
    });
  });
});
