import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRunInDb,
  createTestComposeJob,
  findTestComposeJob,
  deleteStaleTestComposeJobs,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { reloadEnv } from "../../../../../src/env";

const context = testContext();

describe("GET /api/cron/cleanup-sandboxes", () => {
  const cronSecret = "test-cron-secret";
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    // Set CRON_SECRET for tests
    vi.stubEnv("CRON_SECRET", cronSecret);
    reloadEnv();

    // Create test compose
    const { composeId } = await createTestCompose(uniqueId("cleanup"));
    testComposeId = composeId;

    // Clean up stale compose jobs from other tests to ensure isolation
    await deleteStaleTestComposeJobs();
  });

  describe("Authentication", () => {
    it("should reject request without cron secret", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
      );

      const response = await GET(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBeDefined();
    });

    it("should reject request with invalid cron secret", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          headers: {
            Authorization: "Bearer invalid-secret",
          },
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it("should accept request with valid cron secret", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          headers: {
            Authorization: `Bearer ${cronSecret}`,
          },
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
    });
  });

  describe("Cleanup Logic", () => {
    it("should return results structure with cleaned and errors counts", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          headers: {
            Authorization: `Bearer ${cronSecret}`,
          },
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      // Verify response structure
      expect(data).toHaveProperty("cleaned");
      expect(data).toHaveProperty("errors");
      expect(data).toHaveProperty("results");
      expect(typeof data.cleaned).toBe("number");
      expect(typeof data.errors).toBe("number");
      expect(Array.isArray(data.results)).toBe(true);
    });

    it("should NOT cleanup sandbox with recent heartbeat", async () => {
      // Create a run directly in pending state
      const { runId } = await createTestRunInDb(user.userId, testComposeId);

      // Run cleanup immediately (heartbeat is recent)
      const request = createTestRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          headers: {
            Authorization: `Bearer ${cronSecret}`,
          },
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();

      // Our specific run should not be in the cleaned results
      const cleanedRunIds = data.results.map(
        (r: { runId: string }) => r.runId,
      ) as string[];
      expect(cleanedRunIds).not.toContain(runId);
    });

    it("should cleanup expired sandbox after heartbeat timeout", async () => {
      // Record the time when run is created
      const runCreationTime = Date.now();

      // Create a run directly in pending state
      const { runId } = await createTestRunInDb(user.userId, testComposeId);

      // Mock Date.now to return time 6 minutes in the future (past pending timeout of 5 minutes)
      context.mocks.dateNow.mockReturnValue(runCreationTime + 6 * 60 * 1000);

      const request = createTestRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          headers: {
            Authorization: `Bearer ${cronSecret}`,
          },
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();

      // Our specific run should be in the cleaned results
      const cleanedResult = data.results.find(
        (r: { runId: string }) => r.runId === runId,
      );
      expect(cleanedResult).toBeDefined();
      expect(cleanedResult.status).toBe("cleaned");
    });

    it("should NOT cleanup completed runs even with old heartbeat", async () => {
      // Record the time when run is created
      const runCreationTime = Date.now();

      // Create a run directly in completed state
      const { runId } = await createTestRunInDb(user.userId, testComposeId, {
        status: "completed",
      });

      // Mock Date.now to return time 10 minutes in the future
      context.mocks.dateNow.mockReturnValue(runCreationTime + 10 * 60 * 1000);

      const request = createTestRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          headers: {
            Authorization: `Bearer ${cronSecret}`,
          },
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();

      // Our completed run should not be in the cleaned results
      const cleanedRunIds = data.results.map(
        (r: { runId: string }) => r.runId,
      ) as string[];
      expect(cleanedRunIds).not.toContain(runId);
    });

    it("should cleanup multiple expired sandboxes from different users", async () => {
      // Record start time
      const runCreationTime = Date.now();

      // Create run for first user directly in pending state
      const { runId: runId1 } = await createTestRunInDb(
        user.userId,
        testComposeId,
      );

      // Create another user and their compose
      const otherUser = await context.setupUser({ prefix: "other" });
      const { composeId: otherComposeId } = await createTestCompose(
        `cleanup-other-${Date.now()}`,
      );

      // Create run for second user directly in pending state
      const { runId: runId2 } = await createTestRunInDb(
        otherUser.userId,
        otherComposeId,
      );

      // Mock Date.now to return time 6 minutes in the future (past pending timeout of 5 minutes)
      context.mocks.dateNow.mockReturnValue(runCreationTime + 6 * 60 * 1000);

      const request = createTestRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          headers: {
            Authorization: `Bearer ${cronSecret}`,
          },
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();

      // Both runs should be in the cleaned results
      const cleanedRunIds = data.results.map(
        (r: { runId: string }) => r.runId,
      ) as string[];
      expect(cleanedRunIds).toContain(runId1);
      expect(cleanedRunIds).toContain(runId2);
    });

    it("should set run status to timeout with appropriate reason", async () => {
      // Record the time when run is created
      const runCreationTime = Date.now();

      // Create a run directly in pending state
      const { runId } = await createTestRunInDb(user.userId, testComposeId);

      // Mock Date.now to return time 6 minutes in the future (past pending timeout of 5 minutes)
      context.mocks.dateNow.mockReturnValue(runCreationTime + 6 * 60 * 1000);

      const request = createTestRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          headers: {
            Authorization: `Bearer ${cronSecret}`,
          },
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();

      // Find our run in the results
      const cleanedResult = data.results.find(
        (r: { runId: string }) => r.runId === runId,
      );
      expect(cleanedResult).toBeDefined();
      expect(cleanedResult.reason).toBe(
        "Run timed out while pending (never started)",
      );
    });
  });

  describe("Compose Job Cleanup", () => {
    // Use a fixed base time for all compose job tests to avoid spy issues
    const baseTime = new Date("2026-01-15T12:00:00Z");

    function cronRequest() {
      return createTestRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        { headers: { Authorization: `Bearer ${cronSecret}` } },
      );
    }

    it("should clean up stale pending and running compose jobs", async () => {
      const staleTime = new Date(baseTime.getTime() - 11 * 60 * 1000);
      const pendingId = await createTestComposeJob({
        status: "pending",
        createdAt: staleTime,
        userId: "compose-cleanup-user-1",
      });
      const runningId = await createTestComposeJob({
        status: "running",
        createdAt: staleTime,
        userId: "compose-cleanup-user-2",
      });

      context.mocks.dateNow.mockReturnValue(baseTime.getTime());

      const response = await GET(cronRequest());
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.composeJobsCleaned).toBe(2);

      const pending = await findTestComposeJob(pendingId);
      expect(pending?.status).toBe("failed");
      expect(pending?.error).toContain("timed out");

      const running = await findTestComposeJob(runningId);
      expect(running?.status).toBe("failed");
    });

    it("should not touch recent compose jobs", async () => {
      const recentTime = new Date(baseTime.getTime() - 2 * 60 * 1000);
      const recentId = await createTestComposeJob({
        status: "pending",
        createdAt: recentTime,
        userId: "compose-cleanup-recent-user",
      });

      context.mocks.dateNow.mockReturnValue(baseTime.getTime());

      const response = await GET(cronRequest());

      expect(response.status).toBe(200);

      const recent = await findTestComposeJob(recentId);
      expect(recent?.status).toBe("pending");
    });

    it("should not touch completed or failed compose jobs", async () => {
      const staleTime = new Date(baseTime.getTime() - 11 * 60 * 1000);
      const completedId = await createTestComposeJob({
        status: "completed",
        createdAt: staleTime,
      });
      const failedId = await createTestComposeJob({
        status: "failed",
        createdAt: staleTime,
      });

      context.mocks.dateNow.mockReturnValue(baseTime.getTime());

      const response = await GET(cronRequest());
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.composeJobsCleaned).toBe(0);

      const completed = await findTestComposeJob(completedId);
      expect(completed?.status).toBe("completed");

      const failed = await findTestComposeJob(failedId);
      expect(failed?.status).toBe("failed");
    });

    it("should use createdAt as reference time for compose job timeout", async () => {
      const jobId = await createTestComposeJob({
        status: "running",
        createdAt: baseTime,
        userId: "compose-cleanup-user-3",
      });

      // Mock Date.now to 11 minutes after baseTime
      context.mocks.dateNow.mockReturnValue(
        baseTime.getTime() + 11 * 60 * 1000,
      );

      const response = await GET(cronRequest());
      const data = await response.json();

      expect(data.composeJobsCleaned).toBe(1);

      const job = await findTestComposeJob(jobId);
      expect(job?.status).toBe("failed");
      expect(job?.error).toBe(
        "Compose job timed out (no completion callback received)",
      );
    });
  });
});
