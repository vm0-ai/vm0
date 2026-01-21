import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { agentComposes } from "../../../../../src/db/schema/agent-compose";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  createTestRequest,
  createDefaultComposeConfig,
} from "../../../../../src/test/api-test-helpers";

// Mock Clerk auth (external SaaS - needed for compose API)
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

// Mock next/headers to return headers from the current request
let mockAuthHeader: string | null = null;
vi.mock("next/headers", () => ({
  headers: vi.fn().mockImplementation(async () => ({
    get: (name: string) => {
      if (name === "authorization") return mockAuthHeader;
      return null;
    },
  })),
}));

// Mock E2B SDK (external)
vi.mock("@e2b/code-interpreter", () => ({
  Sandbox: {
    connect: vi.fn(),
  },
}));

import { Sandbox } from "@e2b/code-interpreter";
import { auth } from "@clerk/nextjs/server";
import { GET } from "../route";
import { POST as createCompose } from "../../../agent/composes/route";

const mockAuth = vi.mocked(auth);
const mockSandboxConnect = vi.mocked(Sandbox.connect);

describe("GET /api/cron/cleanup-sandboxes", () => {
  const testUserId = `test-user-${Date.now()}-${process.pid}`;
  const testAgentName = `test-agent-cleanup-${Date.now()}`;
  const testRunId1 = randomUUID();
  const testRunId2 = randomUUID();
  let testVersionId: string;
  const cronSecret = "test-cron-secret";

  beforeEach(async () => {
    vi.clearAllMocks();
    initServices();

    // Setup E2B SDK mock - sandbox with kill method
    const mockSandbox = {
      kill: vi.fn().mockResolvedValue(undefined),
    };
    mockSandboxConnect.mockResolvedValue(mockSandbox as unknown as Sandbox);

    // Set CRON_SECRET for tests
    process.env.CRON_SECRET = cronSecret;
    // Reset mock auth header
    mockAuthHeader = null;

    // Mock Clerk auth for compose API
    mockAuth.mockResolvedValue({
      userId: testUserId,
    } as unknown as Awaited<ReturnType<typeof auth>>);

    // Clean up any existing test data
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, testRunId1));

    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, testRunId2));

    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));

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
    testVersionId = data.versionId;
  });

  afterEach(async () => {
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, testRunId1));

    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, testRunId2));

    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));

    delete process.env.CRON_SECRET;
  });

  describe("Authentication", () => {
    it("should reject request without cron secret", async () => {
      mockAuthHeader = null;
      const request = new NextRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          method: "GET",
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBeDefined();
    });

    it("should reject request with invalid cron secret", async () => {
      mockAuthHeader = "Bearer invalid-secret";
      const request = new NextRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          method: "GET",
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it("should accept request with valid cron secret", async () => {
      mockAuthHeader = `Bearer ${cronSecret}`;
      const request = new NextRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          method: "GET",
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
    });
  });

  describe("Cleanup Logic", () => {
    it("should return empty results when no expired sandboxes exist", async () => {
      mockAuthHeader = `Bearer ${cronSecret}`;
      const request = new NextRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          method: "GET",
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.cleaned).toBe(0);
      expect(data.errors).toBe(0);
      expect(data.results).toEqual([]);
    });

    it("should cleanup expired sandbox (heartbeat > 2 minutes ago)", async () => {
      mockAuthHeader = `Bearer ${cronSecret}`;
      // Create a run with expired heartbeat (3 minutes ago)
      const expiredTime = new Date(Date.now() - 3 * 60 * 1000);
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId1,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt",
        sandboxId: "test-sandbox-123",
        createdAt: new Date(),
        lastHeartbeatAt: expiredTime,
      });

      const request = new NextRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          method: "GET",
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.cleaned).toBe(1);
      expect(data.errors).toBe(0);
      expect(data.results).toHaveLength(1);
      expect(data.results[0].runId).toBe(testRunId1);
      expect(data.results[0].status).toBe("cleaned");

      // Verify sandbox was killed via E2B SDK
      expect(Sandbox.connect).toHaveBeenCalledWith("test-sandbox-123");

      // Verify run status was updated to timeout
      const [updatedRun] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, testRunId1));

      expect(updatedRun?.status).toBe("timeout");
      expect(updatedRun?.completedAt).toBeDefined();
    });

    it("should NOT cleanup sandbox with recent heartbeat", async () => {
      mockAuthHeader = `Bearer ${cronSecret}`;
      // Create a run with recent heartbeat (30 seconds ago)
      const recentTime = new Date(Date.now() - 30 * 1000);
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId1,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt",
        sandboxId: "test-sandbox-123",
        createdAt: new Date(),
        lastHeartbeatAt: recentTime,
      });

      const request = new NextRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          method: "GET",
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.cleaned).toBe(0);
      expect(data.results).toEqual([]);

      // Verify sandbox was NOT killed
      expect(Sandbox.connect).not.toHaveBeenCalled();

      // Verify run status unchanged
      const [unchangedRun] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, testRunId1));

      expect(unchangedRun?.status).toBe("running");
    });

    it("should NOT cleanup completed runs even with old heartbeat", async () => {
      mockAuthHeader = `Bearer ${cronSecret}`;
      // Create a completed run with old heartbeat
      const oldTime = new Date(Date.now() - 10 * 60 * 1000);
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId1,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
        status: "completed",
        prompt: "Test prompt",
        sandboxId: "test-sandbox-123",
        createdAt: new Date(),
        lastHeartbeatAt: oldTime,
      });

      const request = new NextRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          method: "GET",
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.cleaned).toBe(0);

      // Verify sandbox was NOT killed
      expect(Sandbox.connect).not.toHaveBeenCalled();
    });

    it("should cleanup multiple expired sandboxes", async () => {
      mockAuthHeader = `Bearer ${cronSecret}`;
      const expiredTime = new Date(Date.now() - 5 * 60 * 1000);

      // Create two runs with expired heartbeats
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId1,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt 1",
        sandboxId: "test-sandbox-1",
        createdAt: new Date(),
        lastHeartbeatAt: expiredTime,
      });

      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId2,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt 2",
        sandboxId: "test-sandbox-2",
        createdAt: new Date(),
        lastHeartbeatAt: expiredTime,
      });

      const request = new NextRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          method: "GET",
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.cleaned).toBe(2);
      expect(data.errors).toBe(0);
      expect(data.results).toHaveLength(2);

      // Verify both sandboxes were killed via E2B SDK
      expect(Sandbox.connect).toHaveBeenCalledTimes(2);
    });

    it("should handle sandbox without sandboxId gracefully", async () => {
      mockAuthHeader = `Bearer ${cronSecret}`;
      const expiredTime = new Date(Date.now() - 3 * 60 * 1000);
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId1,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt",
        sandboxId: null, // No sandbox ID
        createdAt: new Date(),
        lastHeartbeatAt: expiredTime,
      });

      const request = new NextRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          method: "GET",
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.cleaned).toBe(1);

      // Verify sandbox connect was NOT called (no sandboxId)
      expect(Sandbox.connect).not.toHaveBeenCalled();

      // Verify run status was still updated
      const [updatedRun] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, testRunId1));

      expect(updatedRun?.status).toBe("timeout");
    });
  });
});
