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
import { agentRunEvents } from "../../../../../../src/db/schema/agent-run-event";
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

// Mock e2b-service
vi.mock("../../../../../../src/lib/e2b/e2b-service", () => ({
  e2bService: {
    killSandbox: vi.fn().mockResolvedValue(undefined),
  },
}));

import { headers } from "next/headers";
import { auth } from "@clerk/nextjs/server";
import { e2bService } from "../../../../../../src/lib/e2b/e2b-service";

const mockHeaders = vi.mocked(headers);
const mockAuth = vi.mocked(auth);

describe("POST /api/webhooks/agent/complete", () => {
  // Generate unique IDs for this test run
  const testUserId = `test-user-${Date.now()}-${process.pid}`;
  const testRunId = randomUUID();
  const testConfigId = randomUUID();
  const testToken = `vm0_live_test_${Date.now()}_${process.pid}`;
  const testSandboxId = `sandbox-${Date.now()}`;

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
    await globalThis.services.db
      .delete(agentRunEvents)
      .where(eq(agentRunEvents.runId, testRunId));

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
        version: "1.0",
        agent: {
          name: "test-agent",
          image: "test-image",
          provider: "claude-code",
          artifact: {
            working_dir: "/workspace",
          },
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterEach(async () => {
    // Clean up test data after each test
    await globalThis.services.db
      .delete(agentRunEvents)
      .where(eq(agentRunEvents.runId, testRunId));

    await globalThis.services.db
      .delete(agentSessions)
      .where(eq(agentSessions.agentConfigId, testConfigId));

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
  // Authentication Tests
  // ============================================

  describe("Authentication", () => {
    it("should reject complete without authentication", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 0,
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
  // Validation Tests
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

    it("should reject complete without runId", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            // runId: missing
            exitCode: 0,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("runId");
    });

    it("should reject complete without exitCode", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            // exitCode: missing
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("exitCode");
    });
  });

  // ============================================
  // Authorization Tests
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

    it("should reject complete for non-existent run", async () => {
      const nonExistentRunId = randomUUID();

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: nonExistentRunId,
            exitCode: 0,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("Agent run");
    });

    it("should reject complete for run owned by different user", async () => {
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
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 0,
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

    it("should handle successful completion (exitCode=0) and send vm0_result", async () => {
      // Create run with sandboxId
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentConfigId: testConfigId,
        sandboxId: testSandboxId,
        status: "running",
        prompt: "Test prompt",
        createdAt: new Date(),
      });

      // Create conversation for checkpoint
      const conversationId = randomUUID();
      await globalThis.services.db.insert(conversations).values({
        id: conversationId,
        runId: testRunId,
        cliAgentType: "claude-code",
        cliAgentSessionId: "test-session",
        cliAgentSessionHistory: '{"type":"test"}',
        createdAt: new Date(),
      });

      // Create checkpoint (required for success case)
      const checkpointId = randomUUID();
      await globalThis.services.db.insert(checkpoints).values({
        id: checkpointId,
        runId: testRunId,
        conversationId: conversationId,
        agentConfigSnapshot: { config: {}, templateVars: {} },
        artifactSnapshot: {
          artifactName: "test-artifact",
          artifactVersion: "v1",
        },
        createdAt: new Date(),
      });

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 0,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe("completed");

      // Verify run status was updated
      const [updatedRun] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, testRunId));

      expect(updatedRun?.status).toBe("completed");
      expect(updatedRun?.completedAt).toBeDefined();

      // Verify vm0_result event was created
      const events = await globalThis.services.db
        .select()
        .from(agentRunEvents)
        .where(eq(agentRunEvents.runId, testRunId));

      const resultEvent = events.find(
        (e) => (e.eventData as { type: string }).type === "vm0_result",
      );
      expect(resultEvent).toBeDefined();

      // Verify sandbox was killed
      expect(e2bService.killSandbox).toHaveBeenCalledWith(testSandboxId);
    });

    it("should handle failed completion (exitCode≠0) and send vm0_error", async () => {
      // Create run with sandboxId
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentConfigId: testConfigId,
        sandboxId: testSandboxId,
        status: "running",
        prompt: "Test prompt",
        createdAt: new Date(),
      });

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 1,
            error: "Agent crashed",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe("failed");

      // Verify run status was updated
      const [updatedRun] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, testRunId));

      expect(updatedRun?.status).toBe("failed");
      expect(updatedRun?.completedAt).toBeDefined();

      // Verify vm0_error event was created
      const events = await globalThis.services.db
        .select()
        .from(agentRunEvents)
        .where(eq(agentRunEvents.runId, testRunId));

      const errorEvent = events.find(
        (e) => (e.eventData as { type: string }).type === "vm0_error",
      );
      expect(errorEvent).toBeDefined();
      expect((errorEvent?.eventData as { error: string }).error).toBe(
        "Agent crashed",
      );

      // Verify sandbox was killed
      expect(e2bService.killSandbox).toHaveBeenCalledWith(testSandboxId);
    });

    it("should use default error message when exitCode≠0 and no error provided", async () => {
      // Create run
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentConfigId: testConfigId,
        status: "running",
        prompt: "Test prompt",
        createdAt: new Date(),
      });

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 127,
            // no error provided
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);

      // Verify vm0_error event has default message
      const events = await globalThis.services.db
        .select()
        .from(agentRunEvents)
        .where(eq(agentRunEvents.runId, testRunId));

      const errorEvent = events.find(
        (e) => (e.eventData as { type: string }).type === "vm0_error",
      );
      expect((errorEvent?.eventData as { error: string }).error).toBe(
        "Agent exited with code 127",
      );
    });
  });

  // ============================================
  // Error Handling Tests
  // ============================================

  describe("Error Handling", () => {
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

    it("should return 404 when checkpoint not found for successful run", async () => {
      // Create run without checkpoint
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentConfigId: testConfigId,
        status: "running",
        prompt: "Test prompt",
        createdAt: new Date(),
      });

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 0,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("Checkpoint");
    });
  });

  // ============================================
  // Idempotency Tests
  // ============================================

  describe("Idempotency", () => {
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

    it("should return success without processing for already completed run", async () => {
      // Create already completed run
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentConfigId: testConfigId,
        status: "completed",
        prompt: "Test prompt",
        completedAt: new Date(),
        createdAt: new Date(),
      });

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 0,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe("completed");

      // Verify no events were sent (idempotent)
      const events = await globalThis.services.db
        .select()
        .from(agentRunEvents)
        .where(eq(agentRunEvents.runId, testRunId));

      expect(events).toHaveLength(0);

      // Verify sandbox kill was NOT called
      expect(e2bService.killSandbox).not.toHaveBeenCalled();
    });

    it("should return success without processing for already failed run", async () => {
      // Create already failed run
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentConfigId: testConfigId,
        status: "failed",
        prompt: "Test prompt",
        completedAt: new Date(),
        createdAt: new Date(),
      });

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 1,
            error: "Some error",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe("failed");

      // Verify no events were sent (idempotent)
      const events = await globalThis.services.db
        .select()
        .from(agentRunEvents)
        .where(eq(agentRunEvents.runId, testRunId));

      expect(events).toHaveLength(0);

      // Verify sandbox kill was NOT called
      expect(e2bService.killSandbox).not.toHaveBeenCalled();
    });
  });
});
