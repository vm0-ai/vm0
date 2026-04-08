import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestZeroAgent,
  createTestRun,
  createTestSchedule,
  enableTestSchedule,
  getTestSchedule,
  getTestScheduleRuns,
  getTestRun,
  disableAllSchedules,
  clearComposeHeadVersion,
  setScheduleConsecutiveFailures,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { reloadEnv } from "../../../../../src/env";

const context = testContext();

describe("GET /api/cron/execute-schedules", () => {
  let testComposeId: string;
  let testOrgId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    testOrgId = user.orgId;

    const agentName = uniqueId("cron-agent");
    const { composeId } = await createTestCompose(agentName);
    testComposeId = composeId;
    await createTestZeroAgent(user.orgId, agentName, {});
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

  function authenticatedCronRequest() {
    return createTestRequest(
      "http://localhost:3000/api/cron/execute-schedules",
      {
        headers: { Authorization: "Bearer test-secret" },
      },
    );
  }

  describe("Schedule Triggering", () => {
    beforeEach(async () => {
      vi.stubEnv("CRON_SECRET", "test-secret");
      reloadEnv();
      await disableAllSchedules(testOrgId);
    });

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

    it("should not create duplicate runs on concurrent cron invocations", async () => {
      // 1. Mock time to 8:00 AM UTC
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:00:00Z"));

      // 2. Create and enable a cron schedule due at 9 AM
      await createTestSchedule(testComposeId, "concurrent-test", {
        cronExpression: "0 9 * * *",
        prompt: "Daily 9 AM task",
        timezone: "UTC",
      });
      await enableTestSchedule(testComposeId, "concurrent-test");

      // 3. Advance time to 9:01 AM (schedule is now due)
      context.mocks.date.setSystemTime(new Date("2025-01-15T09:01:00Z"));

      // 4. Invoke cron endpoint twice concurrently (simulates Vercel double-fire)
      const [response1, response2] = await Promise.all([
        GET(authenticatedCronRequest()),
        GET(authenticatedCronRequest()),
      ]);
      const [data1, data2] = await Promise.all([
        response1.json(),
        response2.json(),
      ]);

      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);

      // 5. Exactly one invocation should have executed, the other should have skipped
      const totalExecuted = data1.executed + data2.executed;
      expect(totalExecuted).toBe(1);

      // 6. Verify only 1 run was created
      const { runs } = await getTestScheduleRuns(
        testComposeId,
        "concurrent-test",
        10,
      );
      expect(runs.length).toBe(1);
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

    it("should pass appendSystemPrompt from schedule to created run", async () => {
      // 1. Mock time to 8:00 AM UTC
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:00:00Z"));

      // 2. Create schedule with appendSystemPrompt
      await createTestSchedule(testComposeId, "sys-prompt-flow-test", {
        cronExpression: "0 9 * * *",
        prompt: "Daily task",
        appendSystemPrompt: "Always respond in formal tone",
        timezone: "UTC",
      });
      await enableTestSchedule(testComposeId, "sys-prompt-flow-test");

      // 3. Advance time to 9:01 AM (schedule is due)
      context.mocks.date.setSystemTime(new Date("2025-01-15T09:01:00Z"));

      // 4. Execute cron endpoint
      const response = await GET(authenticatedCronRequest());
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.executed).toBeGreaterThanOrEqual(1);

      // 5. Get the created run and verify appendSystemPrompt was passed through
      const { runs } = await getTestScheduleRuns(
        testComposeId,
        "sys-prompt-flow-test",
        1,
      );
      expect(runs.length).toBe(1);

      const run = await getTestRun(runs[0]!.id);
      expect(run.appendSystemPrompt).toContain("Always respond in formal tone");
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

    it("should keep cron schedule enabled after execution", async () => {
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:00:00Z"));

      await createTestSchedule(testComposeId, "cron-stays-enabled", {
        cronExpression: "0 9 * * *",
        prompt: "Daily task",
        timezone: "UTC",
      });
      await enableTestSchedule(testComposeId, "cron-stays-enabled");

      const before = await getTestSchedule(testComposeId, "cron-stays-enabled");
      expect(before.enabled).toBe(true);

      context.mocks.date.setSystemTime(new Date("2025-01-15T09:01:00Z"));

      await GET(authenticatedCronRequest());

      const after = await getTestSchedule(testComposeId, "cron-stays-enabled");
      expect(after.enabled).toBe(true);
      expect(after.lastRunAt).not.toBeNull();
      // nextRunAt is null after execution — cron callback sets it on completion
      expect(after.nextRunAt).toBeNull();
    });
  });

  describe("Loop Schedule Triggering", () => {
    beforeEach(async () => {
      vi.stubEnv("CRON_SECRET", "test-secret");
      reloadEnv();
      await disableAllSchedules(testOrgId);
    });

    it("should execute due loop schedule and set nextRunAt to null", async () => {
      // 1. Mock time so only this test's schedule is due (avoids dev server schedule interference)
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:00:00Z"));

      // 2. Create and enable a loop schedule (nextRunAt = mocked now on enable)
      await createTestSchedule(testComposeId, "loop-trigger-test", {
        intervalSeconds: 300,
        prompt: "Loop task",
      });
      await enableTestSchedule(testComposeId, "loop-trigger-test");

      // Verify it's enabled with nextRunAt set
      const before = await getTestSchedule(testComposeId, "loop-trigger-test");
      expect(before.enabled).toBe(true);
      expect(before.nextRunAt).not.toBeNull();

      // 3. Advance time slightly so schedule is due
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:00:01Z"));

      // 4. Execute cron endpoint (loop schedule should be due)
      const response = await GET(authenticatedCronRequest());
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.executed).toBeGreaterThanOrEqual(1);

      // 5. Verify loop schedule state after execution:
      //    - lastRunAt should be set
      //    - nextRunAt should be null (loop callback handles scheduling next run)
      const after = await getTestSchedule(testComposeId, "loop-trigger-test");
      expect(after.lastRunAt).not.toBeNull();
      expect(after.nextRunAt).toBeNull();
      expect(after.enabled).toBe(true);
    });

    it("should enqueue loop schedule when blocked by concurrency limit", async () => {
      // 1. Mock time so only this test's schedule is due
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:00:00Z"));

      // 2. Create and enable loop schedule
      await createTestSchedule(testComposeId, "loop-queue-test", {
        intervalSeconds: 300,
        prompt: "Loop queue task",
      });
      await enableTestSchedule(testComposeId, "loop-queue-test");

      // 3. Create a blocking run
      await createTestRun(testComposeId, "Blocking run");

      // 4. Advance time slightly so schedule is due
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:00:01Z"));

      // 5. Execute cron - run should be queued (not failed)
      await GET(authenticatedCronRequest());

      // 6. Verify run was queued and schedule state advanced
      const schedule = await getTestSchedule(testComposeId, "loop-queue-test");
      // Loop schedule: nextRunAt should be null (callback handles next iteration)
      expect(schedule.nextRunAt).toBeNull();
      expect(schedule.retryStartedAt).toBeNull();
    });
  });

  describe("Concurrency Queue", () => {
    beforeEach(async () => {
      vi.stubEnv("CRON_SECRET", "test-secret");
      reloadEnv();
      await disableAllSchedules(testOrgId);
    });

    it("should enqueue scheduled run when blocked by concurrency limit", async () => {
      // 1. Set time to 8:00 AM
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:00:00Z"));

      // 2. Create and enable schedule for 9 AM
      await createTestSchedule(testComposeId, "queue-test", {
        cronExpression: "0 9 * * *",
        prompt: "Daily task",
        timezone: "UTC",
      });
      await enableTestSchedule(testComposeId, "queue-test");

      // 3. Advance time close to schedule (within PENDING_RUN_TTL_MS=15min)
      //    so the blocking run is not considered stale by concurrency check
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:55:00Z"));

      // 4. Create a pending run to block concurrency (default limit is 1)
      await createTestRun(testComposeId, "Blocking run");

      // 5. Advance time to 9:01 AM (schedule is due)
      context.mocks.date.setSystemTime(new Date("2025-01-15T09:01:00Z"));

      // 5. Execute cron - run should be queued (not failed)
      const response = await GET(authenticatedCronRequest());
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.executed).toBeGreaterThanOrEqual(1);

      // 6. Verify the run was queued (not failed)
      const { runs } = await getTestScheduleRuns(
        testComposeId,
        "queue-test",
        1,
      );
      expect(runs.length).toBe(1);
      expect(runs[0]?.status).toBe("queued");
    });

    it("should advance cron schedule normally even when run is queued", async () => {
      // 1. Set time to 8:00 AM
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:00:00Z"));

      // 2. Create and enable schedule for 9 AM
      await createTestSchedule(testComposeId, "queue-advance-test", {
        cronExpression: "0 9 * * *",
        prompt: "Daily task",
        timezone: "UTC",
      });
      await enableTestSchedule(testComposeId, "queue-advance-test");

      // 3. Advance time close to schedule (within PENDING_RUN_TTL_MS=15min)
      //    so the blocking run is not considered stale by concurrency check
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:55:00Z"));

      // 4. Create a blocking run
      await createTestRun(testComposeId, "Blocking run");

      // 5. Advance to 9:01 AM and execute cron
      context.mocks.date.setSystemTime(new Date("2025-01-15T09:01:00Z"));
      await GET(authenticatedCronRequest());

      // 5. Verify schedule state after execution (no retry state)
      //    nextRunAt is null — cron callback sets it on completion
      const schedule = await getTestSchedule(
        testComposeId,
        "queue-advance-test",
      );
      expect(schedule.retryStartedAt).toBeNull();
      expect(schedule.nextRunAt).toBeNull();
    });

    it("should disable one-time schedule after queued run", async () => {
      // 1. Set time to 8:00 AM
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:00:00Z"));

      // 2. Create and enable one-time schedule for 9:00 AM
      await createTestSchedule(testComposeId, "onetime-queue-test", {
        atTime: "2025-01-15T09:00:00Z",
        prompt: "One-time task",
        timezone: "UTC",
      });
      await enableTestSchedule(testComposeId, "onetime-queue-test");

      // 3. Advance time close to schedule (within PENDING_RUN_TTL_MS=15min)
      //    so the blocking run is not considered stale by concurrency check
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:55:00Z"));

      // 4. Create a blocking run
      await createTestRun(testComposeId, "Blocking run");

      // 5. Advance to 9:01 AM and execute cron
      context.mocks.date.setSystemTime(new Date("2025-01-15T09:01:00Z"));
      await GET(authenticatedCronRequest());

      // 5. Verify one-time schedule was disabled (run is queued, schedule advances)
      const schedule = await getTestSchedule(
        testComposeId,
        "onetime-queue-test",
      );
      expect(schedule.enabled).toBe(false);
      expect(schedule.nextRunAt).toBeNull();
      expect(schedule.retryStartedAt).toBeNull();
    });
  });

  describe("Pre-Run Failure Handling", () => {
    beforeEach(async () => {
      vi.stubEnv("CRON_SECRET", "test-secret");
      reloadEnv();
      await disableAllSchedules(testOrgId);
    });

    it("should set nextRunAt to next cron occurrence on pre-run failure", async () => {
      // 1. Mock time to 8:00 AM UTC
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:00:00Z"));

      // 2. Create and enable a cron schedule for 9 AM daily
      await createTestSchedule(testComposeId, "cron-prerun-fail", {
        cronExpression: "0 9 * * *",
        prompt: "Daily task",
        timezone: "UTC",
      });
      await enableTestSchedule(testComposeId, "cron-prerun-fail");

      // 3. Clear headVersionId to cause pre-run failure in executeSchedule()
      await clearComposeHeadVersion(testComposeId);

      // 4. Advance time to 9:01 AM (schedule is due)
      context.mocks.date.setSystemTime(new Date("2025-01-15T09:01:00Z"));

      // 5. Execute cron endpoint
      await GET(authenticatedCronRequest());

      // 6. Verify: consecutiveFailures incremented, nextRunAt set to next occurrence
      const schedule = await getTestSchedule(testComposeId, "cron-prerun-fail");
      expect(schedule.consecutiveFailures).toBe(1);
      expect(schedule.enabled).toBe(true);
      expect(schedule.nextRunAt).not.toBeNull();
      // nextRunAt should be Jan 16 at 9:00 AM (next cron occurrence)
      expect(new Date(schedule.nextRunAt!).getTime()).toBeGreaterThan(
        new Date("2025-01-15T09:01:00Z").getTime(),
      );
    });

    it("should set nextRunAt to now + interval on loop pre-run failure", async () => {
      // 1. Mock time
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:00:00Z"));

      // 2. Create and enable a loop schedule
      await createTestSchedule(testComposeId, "loop-prerun-fail", {
        intervalSeconds: 300,
        prompt: "Loop task",
      });
      await enableTestSchedule(testComposeId, "loop-prerun-fail");

      // 3. Clear headVersionId to cause pre-run failure
      await clearComposeHeadVersion(testComposeId);

      // 4. Advance time slightly so schedule is due
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:00:01Z"));

      // 5. Execute cron endpoint
      await GET(authenticatedCronRequest());

      // 6. Verify: consecutiveFailures incremented, nextRunAt ≈ now + 300s
      const schedule = await getTestSchedule(testComposeId, "loop-prerun-fail");
      expect(schedule.consecutiveFailures).toBe(1);
      expect(schedule.enabled).toBe(true);
      expect(schedule.nextRunAt).not.toBeNull();
      const expectedNextRun = new Date("2025-01-15T08:05:01Z"); // now + 300s
      expect(
        Math.abs(
          new Date(schedule.nextRunAt!).getTime() - expectedNextRun.getTime(),
        ),
      ).toBeLessThan(2000);
    });

    it("should auto-disable schedule after 3 consecutive pre-run failures", async () => {
      // 1. Mock time
      context.mocks.date.setSystemTime(new Date("2025-01-15T08:00:00Z"));

      // 2. Create and enable a cron schedule
      await createTestSchedule(testComposeId, "cron-autodisable", {
        cronExpression: "0 9 * * *",
        prompt: "Daily task",
        timezone: "UTC",
      });
      await enableTestSchedule(testComposeId, "cron-autodisable");

      // 3. Set consecutiveFailures to 2 (simulate 2 prior failures)
      await setScheduleConsecutiveFailures(
        testComposeId,
        "cron-autodisable",
        2,
      );

      // 4. Clear headVersionId to cause pre-run failure
      await clearComposeHeadVersion(testComposeId);

      // 5. Advance time to 9:01 AM (schedule is due)
      context.mocks.date.setSystemTime(new Date("2025-01-15T09:01:00Z"));

      // 6. Execute cron endpoint
      await GET(authenticatedCronRequest());

      // 7. Verify: auto-disabled after 3rd failure
      const schedule = await getTestSchedule(testComposeId, "cron-autodisable");
      expect(schedule.consecutiveFailures).toBe(3);
      expect(schedule.enabled).toBe(false);
      expect(schedule.nextRunAt).toBeNull();
    });
  });
});
