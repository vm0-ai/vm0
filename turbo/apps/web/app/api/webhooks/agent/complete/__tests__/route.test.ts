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
import { POST as createCompose } from "../../../../agent/composes/route";
import { NextRequest } from "next/server";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { checkpoints } from "../../../../../../src/db/schema/checkpoint";
import { conversations } from "../../../../../../src/db/schema/conversation";
import { agentSessions } from "../../../../../../src/db/schema/agent-session";
import { agentRunEvents } from "../../../../../../src/db/schema/agent-run-event";
import { agentComposes } from "../../../../../../src/db/schema/agent-compose";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  createTestRequest,
  createDefaultComposeConfig,
  createTestSandboxToken,
} from "../../../../../../src/test/api-test-helpers";

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
  const testAgentName = `test-agent-complete-${Date.now()}`;
  const testRunId = randomUUID();
  let testComposeId: string;
  let testVersionId: string;
  let testToken: string;
  const testSandboxId = `sandbox-${Date.now()}`;

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
    await globalThis.services.db
      .delete(agentRunEvents)
      .where(eq(agentRunEvents.runId, testRunId));

    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, testRunId));

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
    testComposeId = data.composeId;
    testVersionId = data.versionId;

    // Reset auth mock for webhook tests (which use token auth)
    mockAuth.mockResolvedValue({ userId: null } as unknown as Awaited<
      ReturnType<typeof auth>
    >);
  });

  afterEach(async () => {
    // Clean up test data after each test
    await globalThis.services.db
      .delete(agentRunEvents)
      .where(eq(agentRunEvents.runId, testRunId));

    await globalThis.services.db
      .delete(agentSessions)
      .where(eq(agentSessions.agentComposeId, testComposeId));

    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, testRunId));

    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));
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
      // Mock headers() to return the test token (JWT)
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);
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
    it("should reject complete for non-existent run", async () => {
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
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tokenForNonExistentRun}`,
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
      // Mock headers() to return the test token (JWT)
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);
    });

    it("should handle successful completion (exitCode=0) and send vm0_result", async () => {
      // Create run with sandboxId
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
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
        agentComposeSnapshot: { config: {}, vars: {} },
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
      // Run result is now stored directly in the run table (not as vm0_result event)
      expect(updatedRun?.result).toBeDefined();

      // Verify sandbox was killed
      expect(e2bService.killSandbox).toHaveBeenCalledWith(testSandboxId);
    });

    it("should handle failed completion (exitCode≠0) and store error in run table", async () => {
      // Create run with sandboxId
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
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
      // Error is now stored directly in the run table (not as vm0_error event)
      expect(updatedRun?.error).toBe("Agent crashed");

      // Verify sandbox was killed
      expect(e2bService.killSandbox).toHaveBeenCalledWith(testSandboxId);
    });

    it("should use default error message when exitCode≠0 and no error provided", async () => {
      // Create run
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
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

      // Verify error has default message in run table
      const [updatedRun] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, testRunId));

      expect(updatedRun?.error).toBe("Agent exited with code 127");
    });
  });

  // ============================================
  // Error Handling Tests
  // ============================================

  describe("Error Handling", () => {
    beforeEach(async () => {
      // Mock headers() to return the test token (JWT)
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);
    });

    it("should return 404 when checkpoint not found for successful run", async () => {
      // Create run without checkpoint
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
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
      // Mock headers() to return the test token (JWT)
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);
    });

    it("should return success without processing for already completed run", async () => {
      // Create already completed run
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
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
        agentComposeVersionId: testVersionId,
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
