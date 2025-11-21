/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { POST } from "../route";
import { NextRequest } from "next/server";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { agentCheckpoints } from "../../../../../../src/db/schema/agent-checkpoint";
import { agentConfigs } from "../../../../../../src/db/schema/agent-config";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

describe("POST /api/webhooks/agent/checkpoints", () => {
  // Generate unique IDs for this test run to avoid conflicts
  const testUserId = `test-user-${Date.now()}-${process.pid}`;
  const testRunId = randomUUID();
  const testConfigId = randomUUID();
  const testCheckpointId = randomUUID();

  beforeEach(async () => {
    // Initialize services
    initServices();

    // Clean up any existing test data
    await globalThis.services.db
      .delete(agentCheckpoints)
      .where(eq(agentCheckpoints.runId, testRunId));

    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, testRunId));

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
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterEach(async () => {
    // Clean up test data after each test
    await globalThis.services.db
      .delete(agentCheckpoints)
      .where(eq(agentCheckpoints.runId, testRunId));

    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, testRunId));

    await globalThis.services.db
      .delete(agentConfigs)
      .where(eq(agentConfigs.id, testConfigId));
  });

  // ============================================
  // Authentication Tests
  // ============================================

  describe("Authentication", () => {
    it("should reject request without authorization header", async () => {
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
            sessionContent: "test content",
            workingDirectory: "/workspace",
            encodedPath: "encoded",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBeDefined();
      expect(data.error.message).toContain("authorization");
    });

    it("should reject request with invalid authorization format", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "InvalidFormat token123",
          },
          body: JSON.stringify({
            runId: testRunId,
            sessionId: "test-session",
            sessionContent: "test content",
            workingDirectory: "/workspace",
            encodedPath: "encoded",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error.message).toContain("authorization");
    });
  });

  // ============================================
  // Validation Tests
  // ============================================

  describe("Validation", () => {
    it("should reject request without runId", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-token",
          },
          body: JSON.stringify({
            // runId: missing
            sessionId: "test-session",
            sessionContent: "test content",
            workingDirectory: "/workspace",
            encodedPath: "encoded",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("runId");
    });

    it("should reject request without sessionId", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-token",
          },
          body: JSON.stringify({
            runId: testRunId,
            // sessionId: missing
            sessionContent: "test content",
            workingDirectory: "/workspace",
            encodedPath: "encoded",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("sessionId");
    });

    it("should reject request without sessionContent", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-token",
          },
          body: JSON.stringify({
            runId: testRunId,
            sessionId: "test-session",
            // sessionContent: missing
            workingDirectory: "/workspace",
            encodedPath: "encoded",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("sessionContent");
    });

    it("should reject request without workingDirectory", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-token",
          },
          body: JSON.stringify({
            runId: testRunId,
            sessionId: "test-session",
            sessionContent: "test content",
            // workingDirectory: missing
            encodedPath: "encoded",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("workingDirectory");
    });

    it("should reject request without encodedPath", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-token",
          },
          body: JSON.stringify({
            runId: testRunId,
            sessionId: "test-session",
            sessionContent: "test content",
            workingDirectory: "/workspace",
            // encodedPath: missing
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("encodedPath");
    });
  });

  // ============================================
  // Authorization Tests
  // ============================================

  describe("Authorization", () => {
    it("should reject request for non-existent run", async () => {
      const nonExistentRunId = randomUUID();

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-token",
          },
          body: JSON.stringify({
            runId: nonExistentRunId,
            sessionId: "test-session",
            sessionContent: "test content",
            workingDirectory: "/workspace",
            encodedPath: "encoded",
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
  // Success Tests
  // ============================================

  describe("Success", () => {
    it("should create checkpoint with valid data", async () => {
      // Create agent run
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentConfigId: testConfigId,
        status: "completed",
        prompt: "Test prompt",
        createdAt: new Date(),
      });

      const sessionContent = JSON.stringify({
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there!" },
        ],
      });

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-token",
          },
          body: JSON.stringify({
            runId: testRunId,
            sessionId: "test-session-123",
            sessionContent,
            workingDirectory: "/home/user/workspace",
            encodedPath: "L2hvbWUvdXNlci93b3Jrc3BhY2U=",
            volumeSnapshots: [],
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.checkpointId).toBeDefined();
      expect(data.sessionId).toBe("test-session-123");
      expect(data.sessionSize).toBe(sessionContent.length);

      // Verify database
      const checkpoints = await globalThis.services.db
        .select()
        .from(agentCheckpoints)
        .where(eq(agentCheckpoints.runId, testRunId));

      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]?.sessionId).toBe("test-session-123");
      expect(checkpoints[0]?.sessionContent).toBe(sessionContent);
      expect(checkpoints[0]?.workingDirectory).toBe("/home/user/workspace");
      expect(checkpoints[0]?.encodedPath).toBe("L2hvbWUvdXNlci93b3Jrc3BhY2U=");
    });

    it("should create checkpoint with volume snapshots", async () => {
      // Create agent run
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentConfigId: testConfigId,
        status: "completed",
        prompt: "Test prompt",
        createdAt: new Date(),
      });

      const volumeSnapshots = [
        {
          volumeName: "my-repo",
          uri: "github://owner/repo@main",
          commitSha: "abc123",
          driver: "git" as const,
        },
      ];

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-token",
          },
          body: JSON.stringify({
            runId: testRunId,
            sessionId: "test-session-456",
            sessionContent: "session data",
            workingDirectory: "/workspace",
            encodedPath: "encoded",
            volumeSnapshots,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.volumeSnapshots).toEqual(volumeSnapshots);

      // Verify database
      const checkpoints = await globalThis.services.db
        .select()
        .from(agentCheckpoints)
        .where(eq(agentCheckpoints.runId, testRunId));

      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]?.volumeSnapshots).toEqual(volumeSnapshots);
    });
  });

  // ============================================
  // Data Integrity Tests
  // ============================================

  describe("Data Integrity", () => {
    it("should store large session content correctly", async () => {
      // Create agent run
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentConfigId: testConfigId,
        status: "completed",
        prompt: "Test prompt",
        createdAt: new Date(),
      });

      // Create large session content (simulate real JSONL)
      const largeSessionContent = Array.from({ length: 100 }, (_, i) => {
        return JSON.stringify({
          type: "message",
          timestamp: Date.now() + i,
          content: `This is message ${i + 1} with some test data`,
        });
      }).join("\n");

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-token",
          },
          body: JSON.stringify({
            runId: testRunId,
            sessionId: "large-session",
            sessionContent: largeSessionContent,
            workingDirectory: "/workspace",
            encodedPath: "encoded",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(201);

      // Verify database
      const checkpoints = await globalThis.services.db
        .select()
        .from(agentCheckpoints)
        .where(eq(agentCheckpoints.runId, testRunId));

      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]?.sessionContent).toBe(largeSessionContent);
      expect(checkpoints[0]?.sessionContent.split("\n")).toHaveLength(100);
    });

    it("should handle empty volume snapshots array", async () => {
      // Create agent run
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentConfigId: testConfigId,
        status: "completed",
        prompt: "Test prompt",
        createdAt: new Date(),
      });

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-token",
          },
          body: JSON.stringify({
            runId: testRunId,
            sessionId: "empty-volumes",
            sessionContent: "test",
            workingDirectory: "/workspace",
            encodedPath: "encoded",
            volumeSnapshots: [],
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(201);

      // Verify database
      const checkpoints = await globalThis.services.db
        .select()
        .from(agentCheckpoints)
        .where(eq(agentCheckpoints.runId, testRunId));

      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]?.volumeSnapshots).toEqual([]);
    });

    it("should handle missing volumeSnapshots field (defaults to empty array)", async () => {
      // Create agent run
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentConfigId: testConfigId,
        status: "completed",
        prompt: "Test prompt",
        createdAt: new Date(),
      });

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-token",
          },
          body: JSON.stringify({
            runId: testRunId,
            sessionId: "no-volumes",
            sessionContent: "test",
            workingDirectory: "/workspace",
            encodedPath: "encoded",
            // volumeSnapshots: not provided
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(201);

      // Verify database
      const checkpoints = await globalThis.services.db
        .select()
        .from(agentCheckpoints)
        .where(eq(agentCheckpoints.runId, testRunId));

      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]?.volumeSnapshots).toEqual([]);
    });
  });
});
