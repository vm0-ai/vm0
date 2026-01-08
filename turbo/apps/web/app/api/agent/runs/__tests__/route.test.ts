import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from "vitest";
import { POST } from "../route";
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
