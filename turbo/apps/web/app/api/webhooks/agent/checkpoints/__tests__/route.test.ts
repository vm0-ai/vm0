import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  createTestRunDirect,
  createTestSandboxToken,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";

const context = testContext();

describe("POST /api/webhooks/agent/checkpoints", () => {
  let user: UserContext;
  let testComposeId: string;
  let testVersionId: string;
  let testRunId: string;
  let testToken: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    // Create compose for test runs
    const { composeId, versionId } = await createTestCompose(
      uniqueId("checkpoint"),
    );
    testComposeId = composeId;
    testVersionId = versionId;

    // Create a running run
    const { runId } = await createTestRun(testComposeId, "Test prompt");
    testRunId = runId;

    // Generate JWT token for sandbox auth
    testToken = await createTestSandboxToken(user.userId, testRunId);

    // Reset auth mock for webhook tests (which use token auth, not Clerk)
    mockClerk({ userId: null });
  });

  describe("Authentication", () => {
    it("should reject checkpoint without authentication", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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

  describe("Validation", () => {
    it("should reject checkpoint without runId", async () => {
      const request = createTestRequest(
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
      const request = createTestRequest(
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
      const request = createTestRequest(
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
      const sessionHistory = JSON.stringify({
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2025-11-22T04:00:00.000Z",
        content: "test prompt",
        sessionId: "test-session-no-artifact",
      });

      const request = createTestRequest(
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

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.checkpointId).toBeDefined();
      expect(data.agentSessionId).toBeDefined();
      expect(data.conversationId).toBeDefined();
      expect(data.artifact).toBeUndefined();
    });
  });

  describe("Authorization", () => {
    it("should reject checkpoint for non-existent run", async () => {
      const nonExistentRunId = randomUUID();
      const tokenForNonExistentRun = await createTestSandboxToken(
        user.userId,
        nonExistentRunId,
      );

      const request = createTestRequest(
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
      // Create another user with their own run
      await context.setupUser({ prefix: "other" });
      const { composeId: otherComposeId } = await createTestCompose(
        `other-compose-${Date.now()}`,
      );
      const { runId: otherRunId } = await createTestRun(
        otherComposeId,
        "Other user prompt",
      );

      // Switch back to original user and reset Clerk mock
      mockClerk({ userId: null });

      // Generate token for the original user but try to access other user's run
      const tokenWithWrongUser = await createTestSandboxToken(
        user.userId,
        otherRunId, // other user's run
      );

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tokenWithWrongUser}`,
          },
          body: JSON.stringify({
            runId: otherRunId,
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

  describe("Success", () => {
    it("should create checkpoint with artifact snapshot", async () => {
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

      const request = createTestRequest(
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

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.checkpointId).toBeDefined();
      expect(data.agentSessionId).toBeDefined();
      expect(data.conversationId).toBeDefined();
      expect(data.artifact).toEqual(artifactSnapshot);
    });
  });

  describe("Session independence", () => {
    it("should create independent sessions for separate artifact runs", async () => {
      const artifactSnapshot = {
        artifactName: "my-app",
        artifactVersion: "v1",
      };

      // Create two runs directly in DB (bypasses API auth complexity)
      const run1 = await createTestRunDirect(user.userId, testVersionId, {
        prompt: "Run 1",
      });
      const run2 = await createTestRunDirect(user.userId, testVersionId, {
        prompt: "Run 2",
      });

      const token1 = await createTestSandboxToken(user.userId, run1.id);
      const token2 = await createTestSandboxToken(user.userId, run2.id);

      const request1 = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token1}`,
          },
          body: JSON.stringify({
            runId: run1.id,
            cliAgentType: "claude-code",
            cliAgentSessionId: "session-run-1",
            cliAgentSessionHistory: '{"type":"test"}',
            artifactSnapshot,
          }),
        },
      );

      const response1 = await POST(request1);
      expect(response1.status).toBe(200);
      const data1 = await response1.json();

      const request2 = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token2}`,
          },
          body: JSON.stringify({
            runId: run2.id,
            cliAgentType: "claude-code",
            cliAgentSessionId: "session-run-2",
            cliAgentSessionHistory: '{"type":"test"}',
            artifactSnapshot,
          }),
        },
      );

      const response2 = await POST(request2);
      expect(response2.status).toBe(200);
      const data2 = await response2.json();

      // Each run should get its own independent session
      expect(data1.agentSessionId).not.toBe(data2.agentSessionId);
    });

    it("should reuse session when continuedFromSessionId is set", async () => {
      // Create a session via first run's checkpoint
      const request1 = createTestRequest(
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
            cliAgentSessionId: "session-original",
            cliAgentSessionHistory: '{"type":"test"}',
          }),
        },
      );

      const response1 = await POST(request1);
      expect(response1.status).toBe(200);
      const data1 = await response1.json();
      const originalSessionId = data1.agentSessionId;

      // Create a continue run with continuedFromSessionId
      const continueRun = await createTestRunDirect(
        user.userId,
        testVersionId,
        {
          prompt: "Continue prompt",
          continuedFromSessionId: originalSessionId,
        },
      );

      const continueToken = await createTestSandboxToken(
        user.userId,
        continueRun.id,
      );

      const request2 = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${continueToken}`,
          },
          body: JSON.stringify({
            runId: continueRun.id,
            cliAgentType: "claude-code",
            cliAgentSessionId: "session-continued",
            cliAgentSessionHistory: '{"type":"test-continued"}',
          }),
        },
      );

      const response2 = await POST(request2);
      expect(response2.status).toBe(200);
      const data2 = await response2.json();

      // Continue run should reuse the same session
      expect(data2.agentSessionId).toBe(originalSessionId);
    });
  });

  describe("Uniqueness", () => {
    it("should handle duplicate checkpoint requests via upsert", async () => {
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
      const request1 = createTestRequest(
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
      const request2 = createTestRequest(
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
      expect(response2.status).toBe(200);
    });
  });
});
