import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestSchedule,
  enableTestSchedule,
  getTestSchedule,
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
});
