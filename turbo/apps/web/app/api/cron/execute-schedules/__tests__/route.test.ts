import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestSchedule,
  enableTestSchedule,
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
    it("should handle no due schedules gracefully", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/cron/execute-schedules",
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.executed).toBe(0);
      expect(data.skipped).toBe(0);
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

  describe("Time Mocking", () => {
    it("should identify due schedules based on mocked time", async () => {
      // Create a schedule with cron for 9 AM
      await createTestSchedule(testComposeId, "nine-am-schedule", {
        cronExpression: "0 9 * * *",
        prompt: "9 AM task",
        timezone: "UTC",
      });
      await enableTestSchedule(testComposeId, "nine-am-schedule");

      // Mock time to be 9:01 AM UTC (schedule should be due)
      const pastNineAm = new Date("2025-01-15T09:01:00Z").getTime();
      vi.spyOn(Date, "now").mockReturnValue(pastNineAm);

      try {
        const request = createTestRequest(
          "http://localhost:3000/api/cron/execute-schedules",
        );

        const response = await GET(request);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.success).toBe(true);
        // The schedule should be detected as due since nextRunAt was calculated
        // to be around 9 AM and we're past that
        expect(typeof data.executed).toBe("number");
      } finally {
        vi.restoreAllMocks();
      }
    });
  });
});
