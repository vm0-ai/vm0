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
  completeTestRun,
  createTestModelProvider,
} from "../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  setupUser,
  type UserContext,
} from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

/**
 * Helper to create a run via v1 API and return the run ID.
 */
async function createV1Run(
  agentId: string,
  prompt: string,
): Promise<{ id: string; status: string }> {
  const request = createTestRequest("http://localhost:3000/v1/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, prompt }),
  });
  const response = await createRun(request);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(
      `Failed to create run: ${data.error?.message || response.status}`,
    );
  }
  return data;
}

describe("Public API v1 - Runs Endpoints", () => {
  let user: UserContext;
  let testAgentId: string;
  let testAgentName: string;
  let testRunId: string;

  beforeEach(async () => {
    // Setup mocks (E2B, S3, Axiom)
    context.setupMocks();

    // Create unique user for this test
    user = await setupUser();

    // Create test agent with compose
    testAgentName = `agent-${Date.now()}`;
    const { composeId } = await createTestCompose(testAgentName);
    testAgentId = composeId;

    // Create a completed test run for read operations
    const run = await createV1Run(testAgentId, "Test prompt for runs API");
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
      const otherUser = await setupUser({ prefix: "other-user" });
      const { composeId: otherComposeId } = await createTestCompose(
        `other-agent-${Date.now()}`,
      );

      // Create run as other user
      mockClerk({ userId: otherUser.userId });
      const otherRun = await createV1Run(otherComposeId, "Other user prompt");
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
      const run = await createV1Run(testAgentId, "Run to cancel");

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
      // Set limit to 1
      vi.stubEnv("CONCURRENT_RUN_LIMIT", "1");

      try {
        // First run should succeed (creates running run)
        const run1 = await createV1Run(testAgentId, "First concurrent run");
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
        vi.unstubAllEnvs();
      }
    });

    it("should allow unlimited runs when limit is 0", async () => {
      // Set limit to 0 (no limit)
      vi.stubEnv("CONCURRENT_RUN_LIMIT", "0");

      try {
        // Create multiple runs - all should succeed
        const run1 = await createV1Run(testAgentId, "Run 1 with no limit");
        const run2 = await createV1Run(testAgentId, "Run 2 with no limit");
        const run3 = await createV1Run(testAgentId, "Run 3 with no limit");

        expect(run1.status).toBe("running");
        expect(run2.status).toBe("running");
        expect(run3.status).toBe("running");
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe("Model Provider", () => {
    it("should succeed when model provider is configured", async () => {
      // Create model provider
      await createTestModelProvider("anthropic-api-key", "test-api-key-value");

      // Create compose without explicit API key
      const { composeId } = await createTestCompose(`mp-agent-${Date.now()}`, {
        skipDefaultApiKey: true,
        overrides: { framework: "claude-code" },
      });

      const request = createTestRequest("http://localhost:3000/v1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: composeId,
          prompt: "Run with model provider",
        }),
      });

      const response = await createRun(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.id).toBeDefined();
      expect(data.status).toBeDefined();
    });
  });
});
