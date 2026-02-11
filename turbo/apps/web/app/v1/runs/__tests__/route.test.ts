import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET as listRuns, POST as createRun } from "../route";
import { GET as getRun } from "../[id]/route";
import { POST as cancelRun } from "../[id]/cancel/route";
import { GET as getRunLogs } from "../[id]/logs/route";
import { GET as getRunMetrics } from "../[id]/metrics/route";
import { randomUUID } from "crypto";
import {
  createTestRequest,
  createTestCompose,
  createTestV1Run,
  completeTestRun,
  createTestCliToken,
} from "../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("Public API v1 - Runs Endpoints", () => {
  let user: UserContext;
  let testAgentId: string;
  let testAgentName: string;
  let testRunId: string;

  beforeEach(async () => {
    // Setup mocks (E2B, S3, Axiom)
    context.setupMocks();

    // Create unique user for this test
    user = await context.setupUser();

    // Create test agent with compose (use UUID to avoid name conflicts between tests)
    testAgentName = uniqueId("agent");
    const { composeId } = await createTestCompose(testAgentName);
    testAgentId = composeId;

    // Create a completed test run for read operations
    const run = await createTestV1Run(testAgentId, "Test prompt for runs API");
    testRunId = run.id;

    // Complete the run so it doesn't block concurrent limit
    await completeTestRun(user.userId, testRunId);
  });

  describe("GET /v1/runs - List Runs", () => {
    it("should list runs with pagination", async () => {
      const request = createTestRequest("http://localhost:3000/v1/runs");

      const response = await listRuns(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeInstanceOf(Array);
      expect(data.pagination).toBeDefined();
      expect(data.pagination.hasMore).toBeDefined();
    });

    it("should support limit parameter", async () => {
      const request = createTestRequest(
        "http://localhost:3000/v1/runs?limit=1",
      );

      const response = await listRuns(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data.length).toBeLessThanOrEqual(1);
    });

    it("should filter by status", async () => {
      const request = createTestRequest(
        "http://localhost:3000/v1/runs?status=running",
      );

      const response = await listRuns(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeInstanceOf(Array);
      // All returned runs should be running
      for (const run of data.data) {
        expect(run.status).toBe("running");
      }
    });

    it("should return 401 for unauthenticated request", async () => {
      // Mock Clerk to return no user
      mockClerk({ userId: null });

      const request = createTestRequest("http://localhost:3000/v1/runs");

      const response = await listRuns(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.type).toBe("authentication_error");
    });
  });

  describe("GET /v1/runs/:id - Get Run", () => {
    it("should get run by ID", async () => {
      const request = createTestRequest(
        `http://localhost:3000/v1/runs/${testRunId}`,
      );

      const response = await getRun(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(testRunId);
      expect(data.status).toBe("completed");
      expect(data.prompt).toBe("Test prompt for runs API");
      expect(data.agentId).toBe(testAgentId);
      expect(data.agentName).toBe(testAgentName);
    });

    it("should return 404 for non-existent run", async () => {
      const fakeId = randomUUID();
      const request = createTestRequest(
        `http://localhost:3000/v1/runs/${fakeId}`,
      );

      const response = await getRun(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.type).toBe("not_found_error");
      expect(data.error.code).toBe("resource_not_found");
    });

    it("should return 404 for run belonging to another user", async () => {
      // Create another user and their run
      const otherUser = await context.setupUser({ prefix: "other-user" });
      const { composeId: otherComposeId } = await createTestCompose(
        uniqueId("other-agent"),
      );

      // Create run as other user
      mockClerk({ userId: otherUser.userId });
      const otherRun = await createTestV1Run(
        otherComposeId,
        "Other user prompt",
      );
      await completeTestRun(otherUser.userId, otherRun.id);

      // Switch back to original user and try to access other user's run
      mockClerk({ userId: user.userId });
      const request = createTestRequest(
        `http://localhost:3000/v1/runs/${otherRun.id}`,
      );

      const response = await getRun(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.type).toBe("not_found_error");
    });
  });

  describe("POST /v1/runs/:id/cancel - Cancel Run", () => {
    it("should cancel a pending run", async () => {
      // Create a new run (starts as running)
      const run = await createTestV1Run(testAgentId, "Run to cancel");

      const request = createTestRequest(
        `http://localhost:3000/v1/runs/${run.id}/cancel`,
        { method: "POST" },
      );

      const response = await cancelRun(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(run.id);
      expect(data.status).toBe("cancelled");
      expect(data.completedAt).toBeDefined();
    });

    it("should return 400 when cancelling already completed run", async () => {
      // testRunId is already completed in beforeEach
      const request = createTestRequest(
        `http://localhost:3000/v1/runs/${testRunId}/cancel`,
        { method: "POST" },
      );

      const response = await cancelRun(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.type).toBe("invalid_request_error");
      expect(data.error.code).toBe("invalid_state");
    });

    it("should return 404 for non-existent run", async () => {
      const fakeId = randomUUID();
      const request = createTestRequest(
        `http://localhost:3000/v1/runs/${fakeId}/cancel`,
        { method: "POST" },
      );

      const response = await cancelRun(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.type).toBe("not_found_error");
    });

    it("should kill E2B sandbox when cancelling running run", async () => {
      // Create a running run (this will have sandboxId from mock)
      const run = await createTestV1Run(testAgentId, "Run with sandbox");

      // Clear mock to track new calls
      context.mocks.e2b.sandbox.kill.mockClear();

      const request = createTestRequest(
        `http://localhost:3000/v1/runs/${run.id}/cancel`,
        { method: "POST" },
      );

      const response = await cancelRun(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe("cancelled");
      // Verify sandbox kill was called via Sandbox.connect
      expect(context.mocks.e2b.sandbox.kill).toHaveBeenCalled();
    });
  });

  describe("GET /v1/runs/:id/logs - Get Run Logs", () => {
    it("should get logs with empty result when no logs exist", async () => {
      const request = createTestRequest(
        `http://localhost:3000/v1/runs/${testRunId}/logs`,
      );

      const response = await getRunLogs(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeInstanceOf(Array);
      expect(data.pagination).toBeDefined();
    });

    it("should support type filter", async () => {
      const request = createTestRequest(
        `http://localhost:3000/v1/runs/${testRunId}/logs?type=system`,
      );

      const response = await getRunLogs(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeInstanceOf(Array);
    });

    it("should return 404 for non-existent run", async () => {
      const fakeId = randomUUID();
      const request = createTestRequest(
        `http://localhost:3000/v1/runs/${fakeId}/logs`,
      );

      const response = await getRunLogs(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.type).toBe("not_found_error");
    });

    it("should authenticate with CLI token when no Clerk session", async () => {
      // Mock Clerk to return no session
      mockClerk({ userId: null });

      // Create a CLI token for the test user
      const token = await createTestCliToken(user.userId);

      const request = createTestRequest(
        `http://localhost:3000/v1/runs/${testRunId}/logs`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );

      const response = await getRunLogs(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeInstanceOf(Array);
    });
  });

  describe("GET /v1/runs/:id/metrics - Get Run Metrics", () => {
    it("should get metrics with empty data when no metrics exist", async () => {
      const request = createTestRequest(
        `http://localhost:3000/v1/runs/${testRunId}/metrics`,
      );

      const response = await getRunMetrics(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeInstanceOf(Array);
      expect(data.summary).toBeDefined();
      expect(data.summary.avgCpuPercent).toBe(0);
      expect(data.summary.maxMemoryUsedMb).toBe(0);
    });

    it("should return 404 for non-existent run", async () => {
      const fakeId = randomUUID();
      const request = createTestRequest(
        `http://localhost:3000/v1/runs/${fakeId}/metrics`,
      );

      const response = await getRunMetrics(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.type).toBe("not_found_error");
    });
  });

  describe("POST /v1/runs - Create Run", () => {
    it("should create a run with agentId", async () => {
      const request = createTestRequest("http://localhost:3000/v1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testAgentId,
          prompt: "Create a new run",
        }),
      });

      const response = await createRun(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.id).toBeDefined();
      expect(data.status).toBeDefined();
      expect(data.prompt).toBe("Create a new run");
    });

    it("should create a run with agent name", async () => {
      const request = createTestRequest("http://localhost:3000/v1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: testAgentName,
          prompt: "Create run by name",
        }),
      });

      const response = await createRun(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.id).toBeDefined();
      expect(data.agentName).toBe(testAgentName);
    });

    it("should return 404 for non-existent agent", async () => {
      const request = createTestRequest("http://localhost:3000/v1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: "non-existent-agent",
          prompt: "This should fail",
        }),
      });

      const response = await createRun(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.type).toBe("not_found_error");
    });

    it("should return 400 when no agent identifier provided", async () => {
      const request = createTestRequest("http://localhost:3000/v1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Missing agent identifier",
        }),
      });

      const response = await createRun(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.type).toBe("invalid_request_error");
      expect(data.error.code).toBe("missing_parameter");
    });
  });

  describe("Error Response Format", () => {
    it("should return Stripe-style error format", async () => {
      const fakeId = randomUUID();
      const request = createTestRequest(
        `http://localhost:3000/v1/runs/${fakeId}`,
      );

      const response = await getRun(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error).toBeDefined();
      expect(data.error.type).toBe("not_found_error");
      expect(data.error.code).toBe("resource_not_found");
      expect(data.error.message).toContain(fakeId);
    });
  });

  describe("Concurrent Run Limit", () => {
    it("should return 429 when concurrent run limit is reached", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT", "1");

      try {
        // First run should succeed (creates running run)
        const run1 = await createTestV1Run(testAgentId, "First concurrent run");
        expect(run1.status).toBe("running");

        // Second run should fail with 429
        const request = createTestRequest("http://localhost:3000/v1/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId: testAgentId,
            prompt: "Second concurrent run",
          }),
        });

        const response = await createRun(request);
        const data = await response.json();

        expect(response.status).toBe(429);
        expect(data.error.type).toBe("rate_limit_error");
        expect(data.error.message).toMatch(/concurrent/i);
      } finally {
        delete process.env.CONCURRENT_RUN_LIMIT;
      }
    });

    it("should allow unlimited runs when limit is 0", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT", "0");

      try {
        // Create multiple runs - all should succeed
        const run1 = await createTestV1Run(testAgentId, "Run 1 with no limit");
        const run2 = await createTestV1Run(testAgentId, "Run 2 with no limit");
        const run3 = await createTestV1Run(testAgentId, "Run 3 with no limit");

        expect(run1.status).toBe("running");
        expect(run2.status).toBe("running");
        expect(run3.status).toBe("running");
      } finally {
        delete process.env.CONCURRENT_RUN_LIMIT;
      }
    });
  });
});
