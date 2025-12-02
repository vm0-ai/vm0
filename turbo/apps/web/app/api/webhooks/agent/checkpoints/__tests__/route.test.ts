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
import { conversations } from "../../../../../../src/db/schema/conversation";
import { agentSessions } from "../../../../../../src/db/schema/agent-session";
import { cliTokens } from "../../../../../../src/db/schema/cli-tokens";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../../src/db/schema/agent-compose";
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
  const testComposeId = randomUUID();
  const testVersionId =
    randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
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
    // Delete agent_runs first - CASCADE will delete related checkpoints and conversations
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, testRunId));

    await globalThis.services.db
      .delete(cliTokens)
      .where(eq(cliTokens.token, testToken));

    await globalThis.services.db
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.id, testVersionId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.id, testComposeId));

    // Create test agent config
    await globalThis.services.db.insert(agentComposes).values({
      id: testComposeId,
      userId: testUserId,
      name: "test-agent",
      headVersionId: testVersionId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create test agent version
    await globalThis.services.db.insert(agentComposeVersions).values({
      id: testVersionId,
      composeId: testComposeId,
      content: {
        version: "1.0",
        agents: {
          "test-agent": {
            name: "test-agent",
            image: "test-image",
            provider: "claude-code",
            working_dir: "/workspace",
          },
        },
      },
      createdBy: testUserId,
      createdAt: new Date(),
    });
  });

  afterEach(async () => {
    // Clean up test data after each test
    // Delete agent_sessions first (references conversations)
    await globalThis.services.db
      .delete(agentSessions)
      .where(eq(agentSessions.agentComposeId, testComposeId));

    // Delete agent_runs - CASCADE will delete related checkpoints and conversations
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, testRunId));

    await globalThis.services.db
      .delete(cliTokens)
      .where(eq(cliTokens.token, testToken));

    await globalThis.services.db
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.id, testVersionId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.id, testComposeId));
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
            cliAgentType: "claude-code",
            cliAgentSessionId: "test-session",
            cliAgentSessionHistory: '{"type":"test"}',
            artifactSnapshot: {
              artifactName: "test-artifact",
              artifactVersion: "version-123",
            },
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
            cliAgentType: "claude-code",
            cliAgentSessionId: "test-session",
            cliAgentSessionHistory: '{"type":"test"}',
            artifactSnapshot: {
              artifactName: "test-artifact",
              artifactVersion: "version-123",
            },
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("runId");
    });

    it("should reject checkpoint without cliAgentSessionId", async () => {
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
            cliAgentType: "claude-code",
            // cliAgentSessionId: missing
            cliAgentSessionHistory: '{"type":"test"}',
            artifactSnapshot: {
              artifactName: "test-artifact",
              artifactVersion: "version-123",
            },
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("cliAgentSessionId");
    });

    it("should reject checkpoint without cliAgentSessionHistory", async () => {
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
            cliAgentType: "claude-code",
            cliAgentSessionId: "test-session",
            // cliAgentSessionHistory: missing
            artifactSnapshot: {
              artifactName: "test-artifact",
              artifactVersion: "version-123",
            },
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("cliAgentSessionHistory");
    });

    it("should reject checkpoint without artifactSnapshot", async () => {
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
            cliAgentType: "claude-code",
            cliAgentSessionId: "test-session",
            cliAgentSessionHistory: '{"type":"test"}',
            // artifactSnapshot: missing (now required)
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("artifactSnapshot");
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
            cliAgentType: "claude-code",
            cliAgentSessionId: "test-session",
            cliAgentSessionHistory: '{"type":"test"}',
            artifactSnapshot: {
              artifactName: "test-artifact",
              artifactVersion: "version-123",
            },
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
        agentComposeVersionId: testVersionId,
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
            cliAgentType: "claude-code",
            cliAgentSessionId: "test-session",
            cliAgentSessionHistory: '{"type":"test"}',
            artifactSnapshot: {
              artifactName: "test-artifact",
              artifactVersion: "version-123",
            },
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
  // P0 Tests: Success (1 test - artifact is now required)
  // ============================================

  describe("Success", () => {
    it("should create checkpoint with artifact snapshot", async () => {
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
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt",
        templateVars: { user: "testuser" },
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
        artifactName: "test-artifact",
        artifactVersion: "version-123-456",
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
            cliAgentType: "claude-code",
            cliAgentSessionId: "test-session-456",
            cliAgentSessionHistory: sessionHistory,
            artifactSnapshot,
          }),
        },
      );

      const response = await POST(request);

      // Verify response
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.checkpointId).toBeDefined();
      expect(data.agentSessionId).toBeDefined();
      expect(data.conversationId).toBeDefined();
      expect(data.artifact).toEqual(artifactSnapshot);

      // Verify checkpoint in database
      const savedCheckpoints = await globalThis.services.db
        .select()
        .from(checkpoints)
        .where(eq(checkpoints.runId, testRunId));

      expect(savedCheckpoints).toHaveLength(1);
      const checkpoint = savedCheckpoints[0];
      expect(checkpoint?.conversationId).toBeDefined();
      expect(checkpoint?.agentComposeSnapshot).toBeDefined();
      expect(checkpoint?.artifactSnapshot).toEqual(artifactSnapshot);

      // Verify conversation in database
      const savedConversations = await globalThis.services.db
        .select()
        .from(conversations)
        .where(eq(conversations.id, checkpoint!.conversationId));

      expect(savedConversations).toHaveLength(1);
      const conversation = savedConversations[0];
      expect(conversation?.cliAgentType).toBe("claude-code");
      expect(conversation?.cliAgentSessionId).toBe("test-session-456");
      expect(conversation?.cliAgentSessionHistory).toBe(sessionHistory);

      // Verify agentComposeSnapshot contains templateVars
      const configSnapshot = checkpoint?.agentComposeSnapshot as {
        config: unknown;
        templateVars?: Record<string, string>;
      };
      expect(configSnapshot?.templateVars).toEqual({ user: "testuser" });

      // Verify agent session was created/updated
      const savedSessions = await globalThis.services.db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, data.agentSessionId));

      expect(savedSessions).toHaveLength(1);
      const session = savedSessions[0];
      expect(session?.userId).toBe(testUserId);
      expect(session?.agentComposeId).toBe(testComposeId);
      expect(session?.artifactName).toBe("test-artifact");
      expect(session?.conversationId).toBe(checkpoint!.conversationId);
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
        agentComposeVersionId: testVersionId,
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
        cliAgentType: "claude-code",
        cliAgentSessionId: "test-session-unique",
        cliAgentSessionHistory: sessionHistory,
        artifactSnapshot: {
          artifactName: "test-artifact",
          artifactVersion: "version-123",
        },
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
