import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST } from "../route";
import { POST as createCompose } from "../../../../agent/composes/route";
import { NextRequest } from "next/server";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { agentComposes } from "../../../../../../src/db/schema/agent-compose";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  createTestRequest,
  createDefaultComposeConfig,
  createTestSandboxToken,
} from "../../../../../../src/__tests__/api-test-helpers";

// Mock Clerk auth
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

import {
  mockClerk,
  clearClerkMock,
} from "../../../../../../src/__tests__/clerk-mock";

describe("POST /api/webhooks/agent/heartbeat", () => {
  const testUserId = `test-user-${Date.now()}-${process.pid}`;
  const testAgentName = `test-agent-heartbeat-${Date.now()}`;
  const testRunId = randomUUID();
  let testVersionId: string;
  let testToken: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    initServices();

    // Generate JWT token for sandbox auth
    testToken = await createTestSandboxToken(testUserId, testRunId);

    // Mock Clerk auth to return test user (needed for compose API)
    mockClerk({ userId: testUserId });

    // Clean up any existing test data
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

    // Reset auth mock for webhook tests (which use token auth)
    mockClerk({ userId: null });
  });

  afterEach(async () => {
    clearClerkMock();
    // Delete runs by ID (some tests create runs with different userIds)
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, testRunId));

    // Also clean up any runs for testUserId
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));
  });

  describe("Authentication", () => {
    it("should reject heartbeat without authentication", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/heartbeat",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            runId: testRunId,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBeDefined();
    });
  });

  describe("Validation", () => {
    it("should reject heartbeat without runId", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/heartbeat",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({}),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("runId");
    });
  });

  describe("Authorization", () => {
    it("should reject heartbeat for non-existent run", async () => {
      const nonExistentRunId = randomUUID();
      // Generate JWT with the non-existent runId
      const tokenForNonExistentRun = await createTestSandboxToken(
        testUserId,
        nonExistentRunId,
      );

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/heartbeat",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tokenForNonExistentRun}`,
          },
          body: JSON.stringify({
            runId: nonExistentRunId,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("Agent run");
    });

    it("should reject heartbeat for run owned by different user", async () => {
      const otherUserId = `other-user-${Date.now()}-${process.pid}`;

      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: otherUserId,
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt",
        createdAt: new Date(),
      });

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/heartbeat",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(404);
    });
  });

  describe("Success", () => {
    it("should update lastHeartbeatAt for valid heartbeat", async () => {
      const initialTime = new Date(Date.now() - 60000); // 1 minute ago
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt",
        createdAt: new Date(),
        lastHeartbeatAt: initialTime,
      });

      const beforeRequest = new Date();

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/heartbeat",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.ok).toBe(true);

      // Verify database was updated
      const [updatedRun] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, testRunId));

      expect(updatedRun).toBeDefined();
      expect(updatedRun?.lastHeartbeatAt).toBeDefined();
      expect(updatedRun?.lastHeartbeatAt!.getTime()).toBeGreaterThanOrEqual(
        beforeRequest.getTime(),
      );
      expect(updatedRun?.lastHeartbeatAt!.getTime()).toBeGreaterThan(
        initialTime.getTime(),
      );
    });

    it("should handle multiple consecutive heartbeats", async () => {
      const initialTime = new Date(Date.now() - 60000); // 1 minute ago
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt",
        createdAt: new Date(),
        lastHeartbeatAt: initialTime,
      });

      // First heartbeat
      const request1 = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/heartbeat",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({ runId: testRunId }),
        },
      );

      const response1 = await POST(request1);
      expect(response1.status).toBe(200);

      const [run1] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, testRunId));
      const firstHeartbeat = run1?.lastHeartbeatAt;

      expect(firstHeartbeat!.getTime()).toBeGreaterThan(initialTime.getTime());

      // Second heartbeat
      const request2 = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/heartbeat",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({ runId: testRunId }),
        },
      );

      const response2 = await POST(request2);
      expect(response2.status).toBe(200);

      const [run2] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, testRunId));

      // Second heartbeat should be >= first (they may be the same if executed fast enough)
      expect(run2?.lastHeartbeatAt!.getTime()).toBeGreaterThanOrEqual(
        firstHeartbeat!.getTime(),
      );
    });
  });
});
