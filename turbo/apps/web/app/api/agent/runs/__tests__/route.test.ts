/**
 * @vitest-environment node
 */
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
import { NextRequest } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { agentConfigs } from "../../../../../src/db/schema/agent-config";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

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
    executeRun: vi.fn(),
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

describe("POST /api/agent/runs - Async Execution", () => {
  // Generate unique IDs for this test run
  const testUserId = `test-user-${Date.now()}-${process.pid}`;
  const testConfigId = randomUUID();

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

    // Clean up test data
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));

    await globalThis.services.db
      .delete(agentConfigs)
      .where(eq(agentConfigs.id, testConfigId));

    // Create test agent config
    await globalThis.services.db.insert(agentConfigs).values({
      id: testConfigId,
      userId: testUserId,
      name: "test-agent",
      config: {
        agent: {
          name: "test-agent",
          model: "claude-3-5-sonnet-20241022",
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterEach(async () => {
    // Clean up test data
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));

    await globalThis.services.db
      .delete(agentConfigs)
      .where(eq(agentConfigs.id, testConfigId));
  });

  afterAll(async () => {});

  // ============================================
  // Async Execution Tests
  // ============================================

  describe("Async Execution", () => {
    it("should return immediately with 'running' status without waiting for completion", async () => {
      // Mock run service to simulate long-running execution
      // Use a promise that never resolves to verify we don't wait for it
      let resolveExecution: ((value: unknown) => void) | undefined;
      const executionPromise = new Promise((resolve) => {
        resolveExecution = resolve;
      });
      mockRunService.createRunContext.mockResolvedValue({} as never);
      mockRunService.executeRun.mockReturnValue(
        executionPromise as Promise<never>,
      );

      const request = new NextRequest("http://localhost:3000/api/agent/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentConfigId: testConfigId,
          prompt: "Test prompt",
        }),
      });

      const startTime = Date.now();
      const response = await POST(request);
      const endTime = Date.now();

      // Should return quickly (< 1 second) even though E2B hasn't completed
      expect(endTime - startTime).toBeLessThan(1000);

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

      // Clean up: resolve the execution promise to avoid memory leaks
      if (resolveExecution) {
        resolveExecution({
          runId: data.runId,
          status: "completed" as const,
          sandboxId: "test-sandbox",
          output: "test output",
          executionTimeMs: 1000,
          createdAt: new Date(),
        });
      }

      // Wait a bit for the async update to complete
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    it("should update run status to 'completed' after E2B execution finishes successfully", async () => {
      // Mock successful run execution that completes after a delay
      mockRunService.createRunContext.mockResolvedValue({} as never);
      mockRunService.executeRun.mockImplementation(
        (context: never) =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve({
                runId: (context as { runId?: string }).runId || "test-run-id",
                status: "completed" as const,
                sandboxId: "test-sandbox-123",
                output: "Success! Task completed.",
                executionTimeMs: 5000,
                createdAt: new Date(),
                completedAt: new Date(),
              });
            }, 100); // 100ms delay
          }),
      );

      const request = new NextRequest("http://localhost:3000/api/agent/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentConfigId: testConfigId,
          prompt: "Test async completion",
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);
      const data = await response.json();

      // Initially returns running
      expect(data.status).toBe("running");

      // Wait for E2B execution to complete
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Check that run was updated in database
      const [updatedRun] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, data.runId))
        .limit(1);

      expect(updatedRun!.status).toBe("completed");
      expect(updatedRun!.sandboxId).toBe("test-sandbox-123");
      expect(updatedRun!.result).toEqual({
        output: "Success! Task completed.",
        executionTimeMs: 5000,
      });
      expect(updatedRun!.startedAt).toBeDefined();
      expect(updatedRun!.completedAt).toBeDefined();
    });

    it("should update run status to 'failed' if E2B execution fails", async () => {
      // Mock run execution failure
      mockRunService.createRunContext.mockResolvedValue({} as never);
      mockRunService.executeRun.mockImplementation(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => {
              reject(new Error("Sandbox execution failed"));
            }, 100);
          }),
      );

      const request = new NextRequest("http://localhost:3000/api/agent/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentConfigId: testConfigId,
          prompt: "Test async failure",
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);
      const data = await response.json();

      // Initially returns running
      expect(data.status).toBe("running");

      // Wait for E2B execution to fail
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Check that run was marked as failed in database
      const [failedRun] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, data.runId))
        .limit(1);

      expect(failedRun!.status).toBe("failed");
      expect(failedRun!.error).toBe("Sandbox execution failed");
      expect(failedRun!.completedAt).toBeDefined();
    });

    it("should not block API response even if E2B takes a long time", async () => {
      // Mock run service with 5 second delay
      mockRunService.createRunContext.mockResolvedValue({} as never);
      mockRunService.executeRun.mockImplementation(
        (context: never) =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve({
                runId: (context as { runId?: string }).runId || "test-run-id",
                status: "completed" as const,
                sandboxId: "test-sandbox",
                output: "Completed after delay",
                executionTimeMs: 5000,
                createdAt: new Date(),
              });
            }, 5000); // 5 second delay
          }),
      );

      const request = new NextRequest("http://localhost:3000/api/agent/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentConfigId: testConfigId,
          prompt: "Long running task",
        }),
      });

      const startTime = Date.now();
      const response = await POST(request);
      const responseTime = Date.now() - startTime;

      // Should return immediately (< 1 second), not wait for 5 seconds
      expect(responseTime).toBeLessThan(1000);
      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data.status).toBe("running");
    });
  });

  // ============================================
  // Validation Tests (ensure they still work)
  // ============================================

  describe("Validation", () => {
    it("should reject request without agentConfigId", async () => {
      const request = new NextRequest("http://localhost:3000/api/agent/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: "Test prompt",
        }),
      });

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("agentConfigId");
    });

    it("should reject request without prompt", async () => {
      const request = new NextRequest("http://localhost:3000/api/agent/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentConfigId: testConfigId,
        }),
      });

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("prompt");
    });

    it("should reject request for non-existent agent config", async () => {
      const nonExistentConfigId = randomUUID();

      const request = new NextRequest("http://localhost:3000/api/agent/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentConfigId: nonExistentConfigId,
          prompt: "Test prompt",
        }),
      });

      const response = await POST(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("Agent config");
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
          agentConfigId: testConfigId,
          prompt: "Test prompt",
        }),
      });

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error.message).toContain("authenticated");
    });
  });
});
