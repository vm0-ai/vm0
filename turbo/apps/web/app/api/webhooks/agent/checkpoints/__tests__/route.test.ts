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
import { POST as createCompose } from "../../../../agent/composes/route";
import { NextRequest } from "next/server";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { checkpoints } from "../../../../../../src/db/schema/checkpoint";
import { conversations } from "../../../../../../src/db/schema/conversation";
import { agentSessions } from "../../../../../../src/db/schema/agent-session";
import { agentComposes } from "../../../../../../src/db/schema/agent-compose";
import { scopes } from "../../../../../../src/db/schema/scope";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  createTestRequest,
  createDefaultComposeConfig,
  createTestSandboxToken,
} from "../../../../../../src/__tests__/api-test-helpers";

// Mock Next.js headers() function
vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

// Mock Clerk auth (external SaaS)
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

// Mock AWS S3 SDK (external) for blob storage
vi.mock("@aws-sdk/client-s3", () => {
  return {
    S3Client: vi.fn(() => ({})),
    PutObjectCommand: vi.fn(),
    GetObjectCommand: vi.fn(),
    ListObjectsV2Command: vi.fn(),
    DeleteObjectCommand: vi.fn(),
    DeleteObjectsCommand: vi.fn(),
  };
});

// Mock the AWS SDK send method to handle blob operations
vi.mock("@aws-sdk/lib-storage", () => {
  return {
    Upload: vi.fn().mockImplementation(() => ({
      done: vi.fn().mockResolvedValue({
        Location: "https://test-bucket.s3.amazonaws.com/test-key",
        ETag: '"test-etag"',
        Bucket: "test-bucket",
        Key: "test-key",
      }),
    })),
  };
});

// Setup AWS SDK mock responses
const { S3Client } = await import("@aws-sdk/client-s3");
const mockS3Client = S3Client as unknown as ReturnType<typeof vi.fn>;
mockS3Client.mockImplementation(() => ({
  send: vi.fn().mockImplementation(async (command: unknown) => {
    const commandName = (command as { constructor: { name: string } })
      .constructor.name;

    // Handle GetObjectCommand - return session history content
    if (commandName === "GetObjectCommand") {
      const mockContent = "{}";
      return {
        Body: {
          transformToByteArray: async () => Buffer.from(mockContent),
        },
      };
    }

    // Handle PutObjectCommand - successful upload
    if (commandName === "PutObjectCommand") {
      return { ETag: '"test-etag"' };
    }

    return {};
  }),
}));

import { headers } from "next/headers";
import { auth } from "@clerk/nextjs/server";

const mockHeaders = vi.mocked(headers);
const mockAuth = vi.mocked(auth);

describe("POST /api/webhooks/agent/checkpoints", () => {
  // Generate unique IDs for this test run
  const testUserId = `test-user-${Date.now()}-${process.pid}`;
  const testScopeId = randomUUID();
  const testAgentName = `test-agent-checkpoints-${Date.now()}`;
  const testRunId = randomUUID();
  let testComposeId: string;
  let testVersionId: string;
  let testToken: string;

  beforeEach(async () => {
    // Clear all mocks
    vi.clearAllMocks();

    // Initialize services
    initServices();

    // Generate JWT token for sandbox auth
    testToken = await createTestSandboxToken(testUserId, testRunId);

    // Mock Clerk auth to return test user (needed for compose API)
    mockAuth.mockResolvedValue({
      userId: testUserId,
    } as unknown as Awaited<ReturnType<typeof auth>>);

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
    testVersionId = data.versionId;

    // Reset auth mock for webhook tests (which use token auth)
    mockAuth.mockResolvedValue({ userId: null } as unknown as Awaited<
      ReturnType<typeof auth>
    >);
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
      // Mock headers() to return the test token (JWT)
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);
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

    it("should accept checkpoint without artifactSnapshot (optional artifact)", async () => {
      // Setup - create the agent run first
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt without artifact",
        vars: { user: "testuser" },
        createdAt: new Date(),
      });

      const sessionHistory = JSON.stringify({
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2025-11-22T04:00:00.000Z",
        content: "test prompt",
        sessionId: "test-session-no-artifact",
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
            cliAgentSessionId: "test-session-no-artifact",
            cliAgentSessionHistory: sessionHistory,
            // artifactSnapshot: optional - runs without artifact don't have one
          }),
        },
      );

      const response = await POST(request);

      // Should succeed - artifact is now optional
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.checkpointId).toBeDefined();
      expect(data.agentSessionId).toBeDefined();
      expect(data.conversationId).toBeDefined();
      // artifact should be undefined when not provided
      expect(data.artifact).toBeUndefined();
    });
  });

  // ============================================
  // P0 Tests: Authorization (2 tests)
  // ============================================

  describe("Authorization", () => {
    it("should reject checkpoint for non-existent run", async () => {
      const nonExistentRunId = randomUUID();
      // Generate JWT with the non-existent runId
      const tokenForNonExistentRun = await createTestSandboxToken(
        testUserId,
        nonExistentRunId,
      );

      // Mock headers() to return the token
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${tokenForNonExistentRun}`),
      } as unknown as Headers);

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tokenForNonExistentRun}`,
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

      // Mock headers() to return the test token (JWT with testUserId)
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);

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
      // Mock headers() to return the test token (JWT)
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);

      // Setup
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt",
        vars: { user: "testuser" },
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
      // Session history is now stored in R2, referenced by hash
      expect(conversation?.cliAgentSessionHistoryHash).toBeDefined();
      expect(conversation?.cliAgentSessionHistoryHash).toHaveLength(64); // SHA-256 hex
      // Legacy TEXT field should be null for new records
      expect(conversation?.cliAgentSessionHistory).toBeNull();

      // Verify agentComposeSnapshot contains vars
      const configSnapshot = checkpoint?.agentComposeSnapshot as {
        config: unknown;
        vars?: Record<string, string>;
      };
      expect(configSnapshot?.vars).toEqual({ user: "testuser" });

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
    it("should handle duplicate checkpoint requests via upsert", async () => {
      // Mock headers() to return the test token (JWT)
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);

      // Setup
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

      // Second request - should succeed via upsert (update existing)
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
      expect(response2.status).toBe(200); // Upsert handles duplicates gracefully

      // Verify only one checkpoint exists (upsert maintains uniqueness)
      const savedCheckpoints = await globalThis.services.db
        .select()
        .from(checkpoints)
        .where(eq(checkpoints.runId, testRunId));

      expect(savedCheckpoints).toHaveLength(1);
    });
  });
});
