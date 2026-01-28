import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
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
import { eq, and, inArray } from "drizzle-orm";
import { randomUUID } from "crypto";
import { createHash } from "crypto";
import { generateTestId } from "../../../../src/__tests__/api-test-helpers";
import { Sandbox } from "@e2b/code-interpreter";
import * as s3Client from "../../../../src/lib/s3/s3-client";
import { Axiom } from "@axiomhq/js";

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

// Mock Clerk auth (external SaaS)
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

// Mock E2B SDK (external)
vi.mock("@e2b/code-interpreter");

// Mock AWS SDK (external) for S3 operations
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");

// Mock Axiom SDK (external)
vi.mock("@axiomhq/js");

import {
  mockClerk,
  clearClerkMock,
} from "../../../../src/__tests__/clerk-mock";

describe("Public API v1 - Runs Endpoints", () => {
  // Use unique test ID for isolation (no cleanup needed)
  let testUserId: string;
  let testScopeId: string;
  let testAgentId: string;
  let testAgentName: string;
  let testVersionId: string;
  let testRunId: string;

  beforeAll(async () => {
    // Generate unique prefix for this test run
    testUserId = generateTestId();
    testScopeId = randomUUID();

    initServices();

    // Create test scope for the user
    await globalThis.services.db.insert(scopes).values({
      id: testScopeId,
      slug: `test-${testScopeId.slice(0, 8)}`,
      type: "personal",
      ownerId: testUserId,
    });

    // Create test agent with unique name based on testUserId
    testAgentId = randomUUID();
    testAgentName = `${testUserId}-agent`;
    const testConfig = {
      version: "1.0",
      agents: {
        [testAgentName]: {
          image: "vm0/claude-code:dev",
          framework: "claude-code",
          working_dir: "/home/user/workspace",
          environment: {
            ANTHROPIC_API_KEY: "test-api-key",
          },
        },
      },
    };

    await globalThis.services.db.insert(agentComposes).values({
      id: testAgentId,
      name: testAgentName,
      userId: testUserId,
      scopeId: testScopeId,
    });

    // Create test version - include testAgentId in hash for uniqueness
    const configJson = JSON.stringify({
      ...testConfig,
      _testAgentId: testAgentId,
    });
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

    // Create a test run with "completed" status to not block concurrent run limit
    const [run] = await globalThis.services.db
      .insert(agentRuns)
      .values({
        userId: testUserId,
        agentComposeVersionId: testVersionId,
        status: "completed",
        prompt: "Test prompt for runs API",
      })
      .returning();

    testRunId = run!.id;
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // Clean up any active runs from previous tests to avoid concurrent run limit
    await globalThis.services.db
      .update(agentRuns)
      .set({ status: "completed", completedAt: new Date() })
      .where(
        and(
          eq(agentRuns.userId, testUserId),
          inArray(agentRuns.status, ["pending", "running"]),
        ),
      );

    // Mock Clerk auth to return test user by default
    mockClerk({ userId: testUserId });

    // Setup E2B SDK mock - create sandbox
    const mockSandbox = {
      sandboxId: "test-sandbox-123",
      getHostname: () => "test-sandbox.e2b.dev",
      files: {
        write: vi.fn().mockResolvedValue(undefined),
      },
      commands: {
        run: vi.fn().mockResolvedValue({
          stdout: "Mock output",
          stderr: "",
          exitCode: 0,
        }),
      },
      kill: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(Sandbox.create).mockResolvedValue(
      mockSandbox as unknown as Sandbox,
    );

    // Setup S3 mocks
    vi.spyOn(s3Client, "generatePresignedUrl").mockResolvedValue(
      "https://mock-presigned-url",
    );
    vi.spyOn(s3Client, "listS3Objects").mockResolvedValue([]);
    vi.spyOn(s3Client, "uploadS3Buffer").mockResolvedValue(undefined);

    // Mock Axiom SDK
    const mockAxiomClient = {
      query: vi.fn().mockResolvedValue({ matches: [] }),
      ingest: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(Axiom).mockImplementation(
      () => mockAxiomClient as unknown as Axiom,
    );

    // Mock Clerk auth to return test user by default
    mockClerk({ userId: testUserId });
  });

  afterEach(() => {
    clearClerkMock();
  });

  // No afterAll cleanup needed - unique testUserId ensures isolation

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
    it("should cancel a pending run", async () => {
      // Create a pending run to cancel (must be inside test to run after beforeEach cleanup)
      const [run] = await globalThis.services.db
        .insert(agentRuns)
        .values({
          userId: testUserId,
          agentComposeVersionId: testVersionId,
          status: "pending",
          prompt: "Run to cancel",
        })
        .returning();

      const request = createTestRequest(
        `http://localhost:3000/v1/runs/${run!.id}/cancel`,
        { method: "POST" },
      );

      const response = await cancelRun(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(run!.id);
      expect(data.status).toBe("cancelled");
      expect(data.completedAt).toBeDefined();
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
});
