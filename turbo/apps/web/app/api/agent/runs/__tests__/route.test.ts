import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from "vitest";
import { POST, GET } from "../route";
import { POST as createCompose } from "../../composes/route";
import { NextRequest } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { agentComposes } from "../../../../../src/db/schema/agent-compose";
import { scopes } from "../../../../../src/db/schema/scope";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  createTestRequest,
  createDefaultComposeConfig,
} from "../../../../../src/test/api-test-helpers";

// Mock Next.js headers() function
vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

// Mock Clerk auth
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

// Mock run service (which orchestrates e2b execution)
vi.mock("../../../../../src/lib/run", () => ({
  runService: {
    createRunContext: vi.fn(),
    buildExecutionContext: vi.fn(),
    prepareAndDispatch: vi.fn(),
    validateCheckpoint: vi.fn(),
    validateAgentSession: vi.fn(),
  },
}));

// Mock sandbox token generation
vi.mock("../../../../../src/lib/auth/sandbox-token", () => ({
  generateSandboxToken: vi.fn().mockResolvedValue("test-sandbox-token"),
}));

import { headers } from "next/headers";
import { auth } from "@clerk/nextjs/server";
import { runService } from "../../../../../src/lib/run";

const mockHeaders = vi.mocked(headers);
const mockAuth = vi.mocked(auth);
const mockRunService = vi.mocked(runService);

describe("POST /api/agent/runs - Fire-and-Forget Execution", () => {
  // Generate unique IDs for this test run
  const testUserId = `test-user-${Date.now()}-${process.pid}`;
  const testAgentName = `test-agent-runs-${Date.now()}`;
  const testScopeId = randomUUID();
  let testComposeId: string;

  beforeEach(async () => {
    // Clear all mocks
    vi.clearAllMocks();

    // Initialize services
    initServices();

    // Mock headers() - not needed for this endpoint since we use Clerk auth
    mockHeaders.mockResolvedValue({
      get: vi.fn().mockReturnValue(null),
    } as unknown as Headers);

    // Mock Clerk auth to return test user
    mockAuth.mockResolvedValue({
      userId: testUserId,
    } as unknown as Awaited<ReturnType<typeof auth>>);

    // Clean up test data from previous runs
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));

    // Create test scope for the user (required for compose creation)
    await globalThis.services.db.insert(scopes).values({
      id: testScopeId,
      slug: `test-${testScopeId.slice(0, 8)}`,
      type: "personal",
      ownerId: testUserId,
    });

    // Create test compose via API endpoint
    const config = createDefaultComposeConfig(testAgentName);
    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: config }),
      },
    );

    const response = await createCompose(request);
    const data = await response.json();
    testComposeId = data.composeId;
  });

  afterEach(async () => {
    // Clean up test data
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));
  });

  afterAll(async () => {});

  // ============================================
  // Fire-and-Forget Execution Tests
  // ============================================

  describe("Fire-and-Forget Execution", () => {
    it("should return immediately with 'running' status after sandbox preparation", async () => {
      // Mock run service - prepareAndDispatch returns immediately with 'running' status
      // Note: prepareAndDispatch now also updates sandboxId in the database internally
      // buildExecutionContext must pass through runId for the prepareAndDispatch mock to update the correct record
      mockRunService.buildExecutionContext.mockImplementation(
        async (params) => {
          return { runId: params.runId } as never;
        },
      );
      mockRunService.prepareAndDispatch.mockImplementation(async (context) => {
        // Simulate the sandboxId update that now happens inside prepareAndDispatch
        await globalThis.services.db
          .update(agentRuns)
          .set({ sandboxId: "test-sandbox-123", status: "running" })
          .where(eq(agentRuns.id, context.runId));

        return {
          runId: context.runId,
          status: "running" as const,
          sandboxId: "test-sandbox-123",
          createdAt: new Date().toISOString(),
        };
      });

      const request = new NextRequest("http://localhost:3000/api/agent/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          prompt: "Test prompt",
          artifactName: "test-artifact",
        }),
      });

      const startTime = Date.now();
      const response = await POST(request);
      const endTime = Date.now();

      // Should return quickly (sandbox prep only, not agent execution)
      expect(endTime - startTime).toBeLessThan(2000);

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.runId).toBeDefined();
      expect(data.status).toBe("running");

      // Verify run was created in database with 'running' status
      const [run] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, data.runId))
        .limit(1);

      expect(run).toBeDefined();
      expect(run!.status).toBe("running");
      expect(run!.prompt).toBe("Test prompt");
      expect(run!.sandboxId).toBe("test-sandbox-123");
    });

    it("should update sandboxId in database after successful preparation", async () => {
      // Mock successful sandbox preparation
      // Note: prepareAndDispatch now updates sandboxId in the database internally
      // buildExecutionContext must pass through runId for the prepareAndDispatch mock to update the correct record
      mockRunService.buildExecutionContext.mockImplementation(
        async (params) => {
          return { runId: params.runId } as never;
        },
      );
      mockRunService.prepareAndDispatch.mockImplementation(async (context) => {
        // Simulate the sandboxId update that now happens inside prepareAndDispatch
        await globalThis.services.db
          .update(agentRuns)
          .set({ sandboxId: "sandbox-abc-123", status: "running" })
          .where(eq(agentRuns.id, context.runId));

        return {
          runId: context.runId,
          status: "running" as const,
          sandboxId: "sandbox-abc-123",
          createdAt: new Date().toISOString(),
        };
      });

      const request = new NextRequest("http://localhost:3000/api/agent/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          prompt: "Test sandbox ID",
          artifactName: "test-artifact",
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);
      const data = await response.json();

      // Check that sandboxId was saved in database
      const [run] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, data.runId))
        .limit(1);

      expect(run!.sandboxId).toBe("sandbox-abc-123");
      expect(run!.status).toBe("running");
      // completedAt should NOT be set yet (agent still running)
      expect(run!.completedAt).toBeNull();
    });

    it("should return 'failed' status if sandbox preparation fails", async () => {
      // Mock sandbox preparation failure
      mockRunService.buildExecutionContext.mockResolvedValue({} as never);
      mockRunService.prepareAndDispatch.mockRejectedValue(
        new Error("Sandbox preparation failed"),
      );

      const request = new NextRequest("http://localhost:3000/api/agent/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          prompt: "Test preparation failure",
          artifactName: "test-artifact",
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);
      const data = await response.json();

      // Returns failed status immediately for preparation failures
      expect(data.status).toBe("failed");

      // Check that run was marked as failed in database
      const [failedRun] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, data.runId))
        .limit(1);

      expect(failedRun!.status).toBe("failed");
      expect(failedRun!.error).toBe("Sandbox preparation failed");
      expect(failedRun!.completedAt).toBeDefined();
    });

    it("should return quickly even with complex context building", async () => {
      // Mock run service with realistic timing
      mockRunService.buildExecutionContext.mockResolvedValue({} as never);
      mockRunService.prepareAndDispatch.mockResolvedValue({
        runId: "test-run-id",
        status: "running" as const,
        sandboxId: "test-sandbox",
        createdAt: new Date().toISOString(),
      });

      const request = new NextRequest("http://localhost:3000/api/agent/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          prompt: "Quick response test",
          artifactName: "test-artifact",
        }),
      });

      const startTime = Date.now();
      const response = await POST(request);
      const responseTime = Date.now() - startTime;

      // Should return after sandbox prep, not after agent execution
      expect(responseTime).toBeLessThan(3000);
      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data.status).toBe("running");
    });
  });

  // ============================================
  // Validation Tests (ensure they still work)
  // ============================================

  describe("Validation", () => {
    it("should reject request without agentComposeId", async () => {
      const request = new NextRequest("http://localhost:3000/api/agent/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: "Test prompt",
          artifactName: "test-artifact",
        }),
      });

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("agentComposeId");
    });

    it("should reject request without prompt", async () => {
      const request = new NextRequest("http://localhost:3000/api/agent/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          artifactName: "test-artifact",
        }),
      });

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("prompt");
    });

    it("should accept request without artifactName (optional artifact)", async () => {
      const request = new NextRequest("http://localhost:3000/api/agent/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          prompt: "Test prompt",
        }),
      });

      const response = await POST(request);

      // artifactName is now optional - request should be accepted
      // The response should be 200 or 201 (success), not 400 (validation error)
      expect(response.status).not.toBe(400);
    });

    it("should reject request for non-existent agent compose", async () => {
      const nonExistentComposeId = randomUUID();

      const request = new NextRequest("http://localhost:3000/api/agent/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentComposeId: nonExistentComposeId,
          prompt: "Test prompt",
          artifactName: "test-artifact",
        }),
      });

      const response = await POST(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("Agent compose");
    });
  });

  // ============================================
  // Authentication Tests
  // ============================================

  describe("Authentication", () => {
    it("should reject request without authentication", async () => {
      mockAuth.mockResolvedValue({
        userId: null,
      } as unknown as Awaited<ReturnType<typeof auth>>);

      const request = new NextRequest("http://localhost:3000/api/agent/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          prompt: "Test prompt",
          artifactName: "test-artifact",
        }),
      });

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error.message).toContain("authenticated");
    });
  });
});

describe("GET /api/agent/runs - List Runs", () => {
  // Generate unique IDs for this test run
  const testUserId = `test-user-list-${Date.now()}-${process.pid}`;
  const testAgentName = `test-agent-list-${Date.now()}`;
  const testScopeId = randomUUID();
  let testComposeId: string;

  beforeEach(async () => {
    // Clear all mocks
    vi.clearAllMocks();

    // Initialize services
    initServices();

    // Mock headers()
    mockHeaders.mockResolvedValue({
      get: vi.fn().mockReturnValue(null),
    } as unknown as Headers);

    // Mock Clerk auth to return test user
    mockAuth.mockResolvedValue({
      userId: testUserId,
    } as unknown as Awaited<ReturnType<typeof auth>>);

    // Clean up test data from previous runs
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
      slug: `test-list-${testScopeId.slice(0, 8)}`,
      type: "personal",
      ownerId: testUserId,
    });

    // Create test compose via API endpoint
    const config = createDefaultComposeConfig(testAgentName);
    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: config }),
      },
    );

    const response = await createCompose(request);
    const data = await response.json();
    testComposeId = data.composeId;
  });

  afterEach(async () => {
    // Clean up test data
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));
  });

  // Helper to create test runs directly in database
  async function createTestRun(
    overrides: Partial<typeof agentRuns.$inferInsert> = {},
  ) {
    // Get the compose version ID
    const [compose] = await globalThis.services.db
      .select()
      .from(agentComposes)
      .where(eq(agentComposes.id, testComposeId))
      .limit(1);

    const [run] = await globalThis.services.db
      .insert(agentRuns)
      .values({
        userId: testUserId,
        agentComposeVersionId: compose!.headVersionId!,
        status: "completed",
        prompt: "Test prompt",
        ...overrides,
      })
      .returning();

    return run!;
  }

  describe("Authentication", () => {
    it("should return 401 when not authenticated", async () => {
      mockAuth.mockResolvedValue({
        userId: null,
      } as unknown as Awaited<ReturnType<typeof auth>>);

      const request = new NextRequest("http://localhost:3000/api/agent/runs");

      const response = await GET(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error.message).toContain("authenticated");
    });

    it("should return 200 when authenticated", async () => {
      const request = new NextRequest("http://localhost:3000/api/agent/runs");

      const response = await GET(request);

      expect(response.status).toBe(200);
    });
  });

  describe("Data Filtering", () => {
    it("should only return runs belonging to the authenticated user", async () => {
      // Create a run for the test user
      await createTestRun({ prompt: "User's run" });

      // Create a run for a different user (directly in DB)
      const [compose] = await globalThis.services.db
        .select()
        .from(agentComposes)
        .where(eq(agentComposes.id, testComposeId))
        .limit(1);

      await globalThis.services.db.insert(agentRuns).values({
        userId: "different-user-id",
        agentComposeVersionId: compose!.headVersionId!,
        status: "completed",
        prompt: "Different user's run",
      });

      const request = new NextRequest("http://localhost:3000/api/agent/runs");
      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();

      // Should only contain the test user's run
      expect(data.data.length).toBe(1);
      expect(data.data[0].prompt).toBe("User's run");

      // Clean up the other user's run
      await globalThis.services.db
        .delete(agentRuns)
        .where(eq(agentRuns.userId, "different-user-id"));
    });

    it("should filter by status when provided", async () => {
      // Create runs with different statuses
      await createTestRun({ status: "completed", prompt: "Completed run" });
      await createTestRun({ status: "failed", prompt: "Failed run" });
      await createTestRun({ status: "running", prompt: "Running run" });

      const request = new NextRequest(
        "http://localhost:3000/api/agent/runs?status=completed",
      );
      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();

      // Should only contain completed runs
      expect(data.data.length).toBe(1);
      expect(data.data[0].status).toBe("completed");
      expect(data.data[0].prompt).toBe("Completed run");
    });
  });

  describe("Pagination", () => {
    it("should return correct number of items based on limit", async () => {
      // Create 5 runs
      for (let i = 0; i < 5; i++) {
        await createTestRun({ prompt: `Run ${i}` });
      }

      const request = new NextRequest(
        "http://localhost:3000/api/agent/runs?limit=3",
      );
      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.data.length).toBe(3);
      expect(data.pagination.hasMore).toBe(true);
      expect(data.pagination.nextCursor).toBeDefined();
    });

    it("should return hasMore=false when no more items", async () => {
      // Create 2 runs
      await createTestRun({ prompt: "Run 1" });
      await createTestRun({ prompt: "Run 2" });

      const request = new NextRequest(
        "http://localhost:3000/api/agent/runs?limit=10",
      );
      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.data.length).toBe(2);
      expect(data.pagination.hasMore).toBe(false);
      expect(data.pagination.nextCursor).toBeNull();
    });

    it("should paginate correctly using cursor", async () => {
      // Create 5 runs with small delays to ensure different createdAt
      const runs = [];
      for (let i = 0; i < 5; i++) {
        const run = await createTestRun({ prompt: `Run ${i}` });
        runs.push(run);
        // Small delay to ensure different timestamps
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Get first page
      const request1 = new NextRequest(
        "http://localhost:3000/api/agent/runs?limit=2",
      );
      const response1 = await GET(request1);
      const data1 = await response1.json();

      expect(data1.data.length).toBe(2);
      expect(data1.pagination.hasMore).toBe(true);

      // Get second page using cursor
      const cursor = data1.pagination.nextCursor;
      const request2 = new NextRequest(
        `http://localhost:3000/api/agent/runs?limit=2&cursor=${cursor}`,
      );
      const response2 = await GET(request2);
      const data2 = await response2.json();

      expect(data2.data.length).toBe(2);
      expect(data2.pagination.hasMore).toBe(true);

      // Ensure no overlap between pages
      const page1Ids = data1.data.map((r: { id: string }) => r.id);
      const page2Ids = data2.data.map((r: { id: string }) => r.id);
      const overlap = page1Ids.filter((id: string) => page2Ids.includes(id));
      expect(overlap.length).toBe(0);
    });
  });

  describe("Response Format", () => {
    it("should return correct fields for each run", async () => {
      const run = await createTestRun({
        prompt: "Test prompt",
        status: "completed",
      });

      // Update with timestamps
      await globalThis.services.db
        .update(agentRuns)
        .set({
          startedAt: new Date(),
          completedAt: new Date(),
        })
        .where(eq(agentRuns.id, run.id));

      const request = new NextRequest("http://localhost:3000/api/agent/runs");
      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.data.length).toBe(1);
      const returnedRun = data.data[0];

      expect(returnedRun.id).toBe(run.id);
      expect(returnedRun.agentName).toBe(testAgentName);
      expect(returnedRun.status).toBe("completed");
      expect(returnedRun.prompt).toBe("Test prompt");
      expect(returnedRun.createdAt).toBeDefined();
      expect(returnedRun.startedAt).toBeDefined();
      expect(returnedRun.completedAt).toBeDefined();
    });

    it("should return dates as ISO strings", async () => {
      await createTestRun();

      const request = new NextRequest("http://localhost:3000/api/agent/runs");
      const response = await GET(request);

      const data = await response.json();
      const run = data.data[0];

      // Verify ISO date format
      expect(new Date(run.createdAt).toISOString()).toBe(run.createdAt);
    });
  });
});
