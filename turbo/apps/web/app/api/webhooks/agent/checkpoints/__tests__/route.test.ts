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
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { checkpoints } from "../../../../../../src/db/schema/checkpoint";
import { cliTokens } from "../../../../../../src/db/schema/cli-tokens";
import { agentConfigs } from "../../../../../../src/db/schema/agent-config";
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

import { headers } from "next/headers";
import { auth } from "@clerk/nextjs/server";

const mockHeaders = vi.mocked(headers);
const mockAuth = vi.mocked(auth);

describe("POST /api/webhooks/agent/checkpoints", () => {
  // Generate unique IDs for this test run
  const testUserId = `test-user-${Date.now()}-${process.pid}`;
  const testRunId = randomUUID();
  const testConfigId = randomUUID();
  const testToken = `vm0_live_test_${Date.now()}_${process.pid}`;

  beforeEach(async () => {
    // Clear all mocks
    vi.clearAllMocks();

    // Initialize services
    initServices();

    // Mock Clerk auth to return null (fallback for token auth)
    mockAuth.mockResolvedValue({ userId: null } as unknown as Awaited<
      ReturnType<typeof auth>
    >);

    // Mock headers() to return no Authorization header by default
    mockHeaders.mockResolvedValue({
      get: vi.fn().mockReturnValue(null),
    } as unknown as Headers);

    // Clean up any existing test data
    // Delete agent_runs first - CASCADE will delete related checkpoints
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, testRunId));

    await globalThis.services.db
      .delete(cliTokens)
      .where(eq(cliTokens.token, testToken));

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
    // Clean up test data after each test
    // Delete agent_runs first - CASCADE will delete related checkpoints
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, testRunId));

    await globalThis.services.db
      .delete(cliTokens)
      .where(eq(cliTokens.token, testToken));

    await globalThis.services.db
      .delete(agentConfigs)
      .where(eq(agentConfigs.id, testConfigId));
  });

  afterAll(async () => {});

  // ============================================
  // P0 Tests: Authentication (2 tests)
  // ============================================

  describe("Authentication", () => {
    it("should reject checkpoint without authentication", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            runId: testRunId,
            sessionId: "test-session",
            sessionHistory: '{"type":"test"}',
            artifactSnapshot: null,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBeDefined();
      expect(data.error.message).toBeDefined();
    });
  });

  // ============================================
  // P0 Tests: Validation (4 tests)
  // ============================================

  describe("Validation", () => {
    beforeEach(async () => {
      // Mock headers() to return the test token
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);

      // Create valid token for validation tests
      await globalThis.services.db.insert(cliTokens).values({
        token: testToken,
        userId: testUserId,
        name: "Test Token",
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      });
    });

    it("should reject checkpoint without runId", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            // runId: missing
            sessionId: "test-session",
            sessionHistory: '{"type":"test"}',
            artifactSnapshot: null,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("runId");
    });

    it("should reject checkpoint without sessionId", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            // sessionId: missing
            sessionHistory: '{"type":"test"}',
            artifactSnapshot: null,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("sessionId");
    });

    it("should reject checkpoint without sessionHistory", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            sessionId: "test-session",
            // sessionHistory: missing
            artifactSnapshot: null,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("sessionHistory");
    });
  });

  // ============================================
  // P0 Tests: Authorization (2 tests)
  // ============================================

  describe("Authorization", () => {
    beforeEach(async () => {
      // Mock headers() to return the test token
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);

      // Create valid token
      await globalThis.services.db.insert(cliTokens).values({
        token: testToken,
        userId: testUserId,
        name: "Test Token",
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      });
    });

    it("should reject checkpoint for non-existent run", async () => {
      const nonExistentRunId = randomUUID();

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: nonExistentRunId,
            sessionId: "test-session",
            sessionHistory: '{"type":"test"}',
            artifactSnapshot: null,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("Agent run");
    });

    it("should reject checkpoint for run owned by different user", async () => {
      const otherUserId = `other-user-${Date.now()}-${process.pid}`;

      // Create run owned by different user
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: otherUserId,
        agentConfigId: testConfigId,
        status: "running",
        prompt: "Test prompt",
        createdAt: new Date(),
      });

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            sessionId: "test-session",
            sessionHistory: '{"type":"test"}',
            artifactSnapshot: null,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("Agent run");
    });
  });

  // ============================================
  // P0 Tests: Success (2 tests)
  // ============================================

  describe("Success", () => {
    it("should create checkpoint with null artifact snapshot", async () => {
      // Mock headers() to return the test token
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);

      // Setup
      await globalThis.services.db.insert(cliTokens).values({
        token: testToken,
        userId: testUserId,
        name: "Test Token",
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      });

      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentConfigId: testConfigId,
        status: "running",
        prompt: "Test prompt",
        createdAt: new Date(),
      });

      const sessionHistory = JSON.stringify({
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2025-11-22T04:00:00.000Z",
        content: "test prompt",
        sessionId: "test-session-123",
      });

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            sessionId: "test-session-123",
            sessionHistory,
            artifactSnapshot: null,
          }),
        },
      );

      const response = await POST(request);

      // Verify response
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.checkpointId).toBeDefined();
      expect(data.hasArtifact).toBe(false);

      // Verify database
      const savedCheckpoints = await globalThis.services.db
        .select()
        .from(checkpoints)
        .where(eq(checkpoints.runId, testRunId));

      expect(savedCheckpoints).toHaveLength(1);
      const checkpoint = savedCheckpoints[0];
      expect(checkpoint?.sessionId).toBe("test-session-123");
      expect(checkpoint?.sessionHistory).toBe(sessionHistory);
      expect(checkpoint?.artifactSnapshot).toBeNull();
    });

    it("should create checkpoint with git artifact snapshot", async () => {
      // Mock headers() to return the test token
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);

      // Setup
      await globalThis.services.db.insert(cliTokens).values({
        token: testToken,
        userId: testUserId,
        name: "Test Token",
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      });

      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentConfigId: testConfigId,
        status: "running",
        prompt: "Test prompt",
        dynamicVars: { user: "testuser" },
        createdAt: new Date(),
      });

      const sessionHistory = JSON.stringify({
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2025-11-22T04:00:00.000Z",
        content: "test prompt",
        sessionId: "test-session-456",
      });

      const artifactSnapshot = {
        driver: "git" as const,
        mountPath: "/home/user/workspace",
        snapshot: {
          branch: "run-test-run-123",
          commitId: "abc123def456",
        },
      };

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            sessionId: "test-session-456",
            sessionHistory,
            artifactSnapshot,
          }),
        },
      );

      const response = await POST(request);

      // Verify response
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.checkpointId).toBeDefined();
      expect(data.hasArtifact).toBe(true);

      // Verify database
      const savedCheckpoints = await globalThis.services.db
        .select()
        .from(checkpoints)
        .where(eq(checkpoints.runId, testRunId));

      expect(savedCheckpoints).toHaveLength(1);
      const checkpoint = savedCheckpoints[0];
      expect(checkpoint?.sessionId).toBe("test-session-456");
      expect(checkpoint?.sessionHistory).toBe(sessionHistory);
      expect(checkpoint?.agentConfigId).toBe(testConfigId);
      expect(checkpoint?.dynamicVars).toEqual({ user: "testuser" });
      expect(checkpoint?.artifactSnapshot).toEqual(artifactSnapshot);

      // Verify snapshot structure
      const snapshot = checkpoint?.artifactSnapshot as typeof artifactSnapshot;
      expect(snapshot?.driver).toBe("git");
      expect(snapshot?.mountPath).toBe("/home/user/workspace");
      expect(snapshot?.snapshot?.branch).toBe("run-test-run-123");
      expect(snapshot?.snapshot?.commitId).toBe("abc123def456");
    });
  });

  // ============================================
  // P1 Tests: Data Integrity (1 test)
  // ============================================

  describe("Data Integrity", () => {
    it("should preserve dynamic variables from run", async () => {
      // Mock headers() to return the test token
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);

      // Setup
      await globalThis.services.db.insert(cliTokens).values({
        token: testToken,
        userId: testUserId,
        name: "Test Token",
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      });

      const dynamicVars = {
        user: "alice",
        repo: "myrepo",
        branch: "main",
      };

      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentConfigId: testConfigId,
        status: "running",
        prompt: "Test prompt",
        dynamicVars,
        createdAt: new Date(),
      });

      const sessionHistory = JSON.stringify({
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2025-11-22T04:00:00.000Z",
        content: "test prompt",
        sessionId: "test-session-789",
      });

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            sessionId: "test-session-789",
            sessionHistory,
            artifactSnapshot: null,
          }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      // Verify database
      const savedCheckpoints = await globalThis.services.db
        .select()
        .from(checkpoints)
        .where(eq(checkpoints.runId, testRunId));

      expect(savedCheckpoints).toHaveLength(1);
      const checkpoint = savedCheckpoints[0];
      expect(checkpoint?.dynamicVars).toEqual(dynamicVars);
    });
  });

  // ============================================
  // P1 Tests: Uniqueness (1 test)
  // ============================================

  describe("Uniqueness", () => {
    it("should prevent duplicate checkpoints for same run", async () => {
      // Mock headers() to return the test token
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);

      // Setup
      await globalThis.services.db.insert(cliTokens).values({
        token: testToken,
        userId: testUserId,
        name: "Test Token",
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      });

      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentConfigId: testConfigId,
        status: "running",
        prompt: "Test prompt",
        createdAt: new Date(),
      });

      const sessionHistory = JSON.stringify({
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2025-11-22T04:00:00.000Z",
        content: "test prompt",
        sessionId: "test-session-unique",
      });

      const requestBody = {
        runId: testRunId,
        sessionId: "test-session-unique",
        sessionHistory,
        artifactSnapshot: null,
      };

      // First request - should succeed
      const request1 = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify(requestBody),
        },
      );

      const response1 = await POST(request1);
      expect(response1.status).toBe(200);

      // Second request - should fail due to unique constraint
      const request2 = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify(requestBody),
        },
      );

      const response2 = await POST(request2);
      expect(response2.status).toBe(500); // Database constraint violation

      // Verify only one checkpoint exists
      const savedCheckpoints = await globalThis.services.db
        .select()
        .from(checkpoints)
        .where(eq(checkpoints.runId, testRunId));

      expect(savedCheckpoints).toHaveLength(1);
    });
  });
});
