import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  completeTestRun,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

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

    // Create test compose
    const { composeId } = await createTestCompose(`cleanup-${Date.now()}`);
    testComposeId = composeId;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CRON_SECRET;
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
      // Create a run that will be in running state
      const { runId } = await createTestRun(testComposeId, "Test prompt");

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

    it("should cleanup expired sandbox after heartbeat timeout using fake timers", async () => {
      // Use fake timers BEFORE creating the run so Date.now() is controlled
      const baseTime = Date.now();
      vi.useFakeTimers({ now: baseTime });

      // Create a run - it will have lastHeartbeatAt = baseTime
      const { runId } = await createTestRun(testComposeId, "Test prompt");

      // Advance time past the heartbeat timeout (2 minutes)
      vi.advanceTimersByTime(3 * 60 * 1000); // 3 minutes

      // Re-mock E2B sandbox for the cleanup call
      const mockKill = vi.fn().mockResolvedValue(undefined);
      vi.mocked(
        (await import("@e2b/code-interpreter")).Sandbox.connect,
      ).mockResolvedValue({
        kill: mockKill,
      } as unknown as Awaited<
        ReturnType<typeof import("@e2b/code-interpreter").Sandbox.connect>
      >);

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
      // Use fake timers
      const baseTime = Date.now();
      vi.useFakeTimers({ now: baseTime });

      // Create and complete a run
      const { runId } = await createTestRun(testComposeId, "Test prompt");
      await completeTestRun(user.userId, runId);

      // Advance time past the heartbeat timeout
      vi.advanceTimersByTime(10 * 60 * 1000); // 10 minutes

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
      // Record start time for fake timers
      const baseTime = Date.now();

      // Create run for first user
      const { runId: runId1 } = await createTestRun(
        testComposeId,
        "Test prompt 1",
      );

      // Create another user and their compose
      await context.setupUser({ prefix: "other" });
      const { composeId: otherComposeId } = await createTestCompose(
        `cleanup-other-${Date.now()}`,
      );

      // Create run for second user
      const { runId: runId2 } = await createTestRun(
        otherComposeId,
        "Test prompt 2",
      );

      // Now enable fake timers and advance time
      // Both runs have lastHeartbeatAt ≈ baseTime
      vi.useFakeTimers({ now: baseTime + 5 * 60 * 1000 }); // 5 minutes in future

      // Mock E2B for cleanup
      const mockKill = vi.fn().mockResolvedValue(undefined);
      vi.mocked(
        (await import("@e2b/code-interpreter")).Sandbox.connect,
      ).mockResolvedValue({
        kill: mockKill,
      } as unknown as Awaited<
        ReturnType<typeof import("@e2b/code-interpreter").Sandbox.connect>
      >);

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
      // Use fake timers
      const baseTime = Date.now();
      vi.useFakeTimers({ now: baseTime });

      // Create a run
      const { runId } = await createTestRun(testComposeId, "Test prompt");

      // Advance time past heartbeat timeout
      vi.advanceTimersByTime(3 * 60 * 1000); // 3 minutes

      // Mock E2B for cleanup
      vi.mocked(
        (await import("@e2b/code-interpreter")).Sandbox.connect,
      ).mockResolvedValue({
        kill: vi.fn().mockResolvedValue(undefined),
      } as unknown as Awaited<
        ReturnType<typeof import("@e2b/code-interpreter").Sandbox.connect>
      >);

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
      expect(cleanedResult.reason).toBe("Run timed out (no heartbeat)");
    });

    it("should call E2B sandbox.connect and kill for expired runs with sandboxId", async () => {
      // Use fake timers
      const baseTime = Date.now();
      vi.useFakeTimers({ now: baseTime });

      // Create a run (will have sandboxId from the mock)
      await createTestRun(testComposeId, "Test prompt");

      // Advance time past heartbeat timeout
      vi.advanceTimersByTime(3 * 60 * 1000); // 3 minutes

      // Track E2B calls
      const mockKill = vi.fn().mockResolvedValue(undefined);
      const mockConnect = vi.mocked(
        (await import("@e2b/code-interpreter")).Sandbox.connect,
      );
      mockConnect.mockResolvedValue({
        kill: mockKill,
      } as unknown as Awaited<ReturnType<typeof mockConnect>>);

      const request = createTestRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          headers: {
            Authorization: `Bearer ${cronSecret}`,
          },
        },
      );

      await GET(request);

      // Verify E2B was called to connect and kill the sandbox
      expect(mockConnect).toHaveBeenCalled();
      expect(mockKill).toHaveBeenCalled();
    });
  });
});
