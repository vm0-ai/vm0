import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as listRuns, POST as createRun } from "../route";
import { GET as getRun } from "../[id]/route";
import { POST as cancelRun } from "../[id]/cancel/route";
import { GET as getRunLogs } from "../[id]/logs/route";
import { GET as getRunMetrics } from "../[id]/metrics/route";
import { initServices } from "../../../../src/lib/init-services";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { scopes } from "../../../../src/db/schema/scope";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { createHash } from "crypto";

/**
 * Helper to create a NextRequest for testing.
 */
function createTestRequest(
  url: string,
  options?: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  },
): NextRequest {
  return new NextRequest(url, {
    method: options?.method ?? "GET",
    headers: options?.headers ?? {},
    body: options?.body,
  });
}

// Mock the auth module
let mockUserId = "test-user-runs-api";
vi.mock("../../../../src/lib/auth/get-user-id", () => ({
  getUserId: async () => mockUserId,
}));

// Mock runService for create tests
vi.mock("../../../../src/lib/run", () => ({
  runService: {
    validateCheckpoint: vi.fn(),
    validateAgentSession: vi.fn(),
    buildExecutionContext: vi.fn().mockResolvedValue({}),
    prepareAndDispatch: vi.fn().mockResolvedValue({ status: "pending" }),
  },
}));

// Mock sandbox token generation
vi.mock("../../../../src/lib/auth/sandbox-token", () => ({
  generateSandboxToken: vi.fn().mockResolvedValue("mock-sandbox-token"),
}));

// Mock Axiom for logs and metrics
vi.mock("../../../../src/lib/axiom", () => ({
  queryAxiom: vi.fn().mockResolvedValue([]),
  ingestRequestLog: vi.fn(),
  ingestSandboxOpLog: vi.fn(),
  getDatasetName: vi.fn((base: string) => `vm0-${base}-test`),
  DATASETS: {
    SANDBOX_TELEMETRY_SYSTEM: "sandbox-telemetry-system",
    SANDBOX_TELEMETRY_METRICS: "sandbox-telemetry-metrics",
    SANDBOX_TELEMETRY_NETWORK: "sandbox-telemetry-network",
    AGENT_RUN_EVENTS: "agent-run-events",
    WEB_LOGS: "web-logs",
    REQUEST_LOG: "request-log",
    SANDBOX_OP_LOG: "sandbox-op-log",
  },
}));

describe("Public API v1 - Runs Endpoints", () => {
  const testUserId = "test-user-runs-api";
  const testScopeId = randomUUID();
  let testAgentId: string;
  let testVersionId: string;
  let testRunId: string;

  beforeAll(async () => {
    initServices();

    // Clean up any existing test data
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));

    // Create test scope for the user
    await globalThis.services.db.insert(scopes).values({
      id: testScopeId,
      slug: `test-${testScopeId.slice(0, 8)}`,
      type: "personal",
      ownerId: testUserId,
    });

    // Create test agent
    testAgentId = randomUUID();
    const testConfig = {
      version: "1.0",
      agents: {
        "test-agent-runs": {
          image: "vm0/claude-code:dev",
          provider: "claude-code",
        },
      },
    };

    await globalThis.services.db.insert(agentComposes).values({
      id: testAgentId,
      name: "test-agent-runs",
      userId: testUserId,
      scopeId: testScopeId,
    });

    // Create test version
    const configJson = JSON.stringify(testConfig);
    testVersionId = createHash("sha256").update(configJson).digest("hex");

    await globalThis.services.db.insert(agentComposeVersions).values({
      id: testVersionId,
      composeId: testAgentId,
      createdBy: testUserId,
      content: testConfig,
    });

    // Update agent with head version
    await globalThis.services.db
      .update(agentComposes)
      .set({ headVersionId: testVersionId })
      .where(eq(agentComposes.id, testAgentId));

    // Create a test run
    const [run] = await globalThis.services.db
      .insert(agentRuns)
      .values({
        userId: testUserId,
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt for runs API",
      })
      .returning();

    testRunId = run!.id;
  });

  afterAll(async () => {
    // Cleanup: Delete test data
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));

    await globalThis.services.db
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.composeId, testAgentId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));
  });

  describe("GET /v1/runs - List Runs", () => {
    it("should list runs with pagination", async () => {
      const request = createTestRequest("http://localhost:3000/v1/runs");

      const response = await listRuns(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeInstanceOf(Array);
      expect(data.pagination).toBeDefined();
      expect(data.pagination.has_more).toBeDefined();
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
      mockUserId = "";

      const request = createTestRequest("http://localhost:3000/v1/runs");

      const response = await listRuns(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.type).toBe("authentication_error");

      mockUserId = testUserId;
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
      expect(data.status).toBe("running");
      expect(data.prompt).toBe("Test prompt for runs API");
      expect(data.agent_id).toBe(testAgentId);
      expect(data.agent_name).toBe("test-agent-runs");
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
      // Create run with different user
      const [otherRun] = await globalThis.services.db
        .insert(agentRuns)
        .values({
          userId: "other-user",
          agentComposeVersionId: testVersionId,
          status: "pending",
          prompt: "Other user prompt",
        })
        .returning();

      const request = createTestRequest(
        `http://localhost:3000/v1/runs/${otherRun!.id}`,
      );

      const response = await getRun(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.type).toBe("not_found_error");

      // Cleanup
      await globalThis.services.db
        .delete(agentRuns)
        .where(eq(agentRuns.id, otherRun!.id));
    });
  });

  describe("POST /v1/runs/:id/cancel - Cancel Run", () => {
    let runToCancel: string;

    beforeAll(async () => {
      // Create a pending run to cancel
      const [run] = await globalThis.services.db
        .insert(agentRuns)
        .values({
          userId: testUserId,
          agentComposeVersionId: testVersionId,
          status: "pending",
          prompt: "Run to cancel",
        })
        .returning();

      runToCancel = run!.id;
    });

    it("should cancel a pending run", async () => {
      const request = createTestRequest(
        `http://localhost:3000/v1/runs/${runToCancel}/cancel`,
        { method: "POST" },
      );

      const response = await cancelRun(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(runToCancel);
      expect(data.status).toBe("cancelled");
      expect(data.completed_at).toBeDefined();
    });

    it("should return 400 when cancelling already completed run", async () => {
      // Create a completed run
      const [completedRun] = await globalThis.services.db
        .insert(agentRuns)
        .values({
          userId: testUserId,
          agentComposeVersionId: testVersionId,
          status: "completed",
          prompt: "Completed run",
          completedAt: new Date(),
        })
        .returning();

      const request = createTestRequest(
        `http://localhost:3000/v1/runs/${completedRun!.id}/cancel`,
        { method: "POST" },
      );

      const response = await cancelRun(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.type).toBe("invalid_request_error");
      expect(data.error.code).toBe("invalid_state");

      // Cleanup
      await globalThis.services.db
        .delete(agentRuns)
        .where(eq(agentRuns.id, completedRun!.id));
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
      expect(data.summary.avg_cpu_percent).toBe(0);
      expect(data.summary.max_memory_used_mb).toBe(0);
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
    it("should create a run with agent_id", async () => {
      const request = createTestRequest("http://localhost:3000/v1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: testAgentId,
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
          agent: "test-agent-runs",
          prompt: "Create run by name",
        }),
      });

      const response = await createRun(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.id).toBeDefined();
      expect(data.agent_name).toBe("test-agent-runs");
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
});
