import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  createTestRunInDb,
  createTestSchedule,
  completeTestRun,
  failTestRun,
  createOrphanTestRun,
  insertOrgMembersCacheEntry,
} from "../../../../../../src/__tests__/api-test-helpers";
import { createTestZeroAgent } from "../../../../../../src/__tests__/db-test-seeders/agents";
import {
  testContext,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";
import {
  generateZeroToken,
  generateSandboxToken,
} from "../../../../../../src/lib/auth/sandbox-token";

vi.mock("@e2b/code-interpreter", () => {
  return {
    Sandbox: {
      create: vi.fn().mockResolvedValue({
        sandboxId: "mock-sandbox-id",
        files: { write: vi.fn().mockResolvedValue(undefined) },
        commands: { run: vi.fn().mockResolvedValue({ exitCode: 0 }) },
      }),
      connect: vi.fn(),
    },
  };
});

const context = testContext();

describe("GET /api/zero/logs/[id]", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    // Create test compose
    const { composeId } = await createTestCompose(
      `logs-detail-${randomUUID().slice(0, 8)}`,
    );
    testComposeId = composeId;
  });

  it("should return 401 when not authenticated", async () => {
    // Create a run first
    const { runId } = await createTestRun(testComposeId, "Test prompt");

    // Mock Clerk to return no user
    mockClerk({ userId: null });

    const request = createTestRequest(
      `http://localhost:3000/api/zero/logs/${runId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toBe("Not authenticated");
  });

  it("should return 400 for invalid UUID format", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/logs/invalid-uuid",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should return 404 for non-existent run", async () => {
    const nonExistentId = randomUUID();
    const request = createTestRequest(
      `http://localhost:3000/api/zero/logs/${nonExistentId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should return 404 when accessing another user's run", async () => {
    // Create another user with their own compose and run
    await context.setupUser({ prefix: "other" });
    const { composeId: otherComposeId } = await createTestCompose(
      `other-logs-${Date.now()}`,
    );

    // Create run for other user
    const otherRun = await createTestRun(otherComposeId, "Other user prompt");

    // Switch back to original user
    mockClerk({ userId: user.userId });

    // Try to access other user's run
    const request = createTestRequest(
      `http://localhost:3000/api/zero/logs/${otherRun.runId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should return run details for authenticated owner", async () => {
    // Create and complete a run
    const { runId } = await createTestRun(testComposeId, "Test prompt");
    await completeTestRun(user.userId, runId);

    const request = createTestRequest(
      `http://localhost:3000/api/zero/logs/${runId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(runId);
    expect(data.agentId).toBe(testComposeId);
    expect(data.framework).toBe("claude-code");
    expect(data.status).toBe("completed");
    expect(data.prompt).toBe("Test prompt");
    expect(data.error).toBeNull();
    expect(data.createdAt).toBeDefined();
    expect(data.completedAt).toBeDefined();
    expect(data.sessionId).toBeDefined();
  });

  it("should return displayName from agent metadata", async () => {
    const agentName = `display-name-id-${randomUUID().slice(0, 8)}`;
    const { composeId } = await createTestCompose(agentName);
    // Seed zero_agents with displayName (metadata now lives in this table)
    await createTestZeroAgent(user.orgId, agentName, {
      displayName: "Agent Display Name",
    });
    const { runId } = await createTestRun(composeId, "Test prompt");
    await completeTestRun(user.userId, runId);

    const request = createTestRequest(
      `http://localhost:3000/api/zero/logs/${runId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(runId);
    expect(data.displayName).toBe("Agent Display Name");
  });

  it("should return null displayName when agent metadata has none", async () => {
    const { runId } = await createTestRun(testComposeId, "Test prompt");
    await completeTestRun(user.userId, runId);

    const request = createTestRequest(
      `http://localhost:3000/api/zero/logs/${runId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(runId);
    expect(data.displayName).toBeNull();
  });

  it("should handle pending run status", async () => {
    // Create run but don't complete it (stays in pending status)
    const { runId, status } = await createTestRun(testComposeId, "Test prompt");

    // Run should be in pending state
    expect(status).toBe("pending");

    const request = createTestRequest(
      `http://localhost:3000/api/zero/logs/${runId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(runId);
    expect(data.status).toBe("pending");
    expect(data.sessionId).toBeNull();
    expect(data.completedAt).toBeNull();
  });

  it("should handle failed run with error message", async () => {
    // Create a run and then fail it via the complete webhook
    const { runId } = await createTestRun(testComposeId, "Test prompt");
    await failTestRun(user.userId, runId, "Sandbox creation failed");

    const request = createTestRequest(
      `http://localhost:3000/api/zero/logs/${runId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe("failed");
    expect(data.error).toBeDefined();
  });

  it("should return scheduleId when run was triggered by a schedule", async () => {
    const schedule = await createTestSchedule(
      testComposeId,
      `sched-detail-${randomUUID().slice(0, 8)}`,
    );

    const { runId } = await createTestRunInDb(user.userId, testComposeId, {
      status: "completed",
      scheduleId: schedule.id,
      triggerSource: "schedule",
      startedAt: new Date(),
      completedAt: new Date(),
    });

    const request = createTestRequest(
      `http://localhost:3000/api/zero/logs/${runId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(runId);
    expect(data.scheduleId).toBe(schedule.id);
    expect(data.triggerSource).toBe("schedule");
  });

  it("should return null scheduleId for non-schedule runs", async () => {
    const { runId } = await createTestRun(testComposeId, "Test prompt");
    await completeTestRun(user.userId, runId);

    const request = createTestRequest(
      `http://localhost:3000/api/zero/logs/${runId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(runId);
    expect(data.scheduleId).toBeNull();
  });

  it("should return run details when compose version has been deleted", async () => {
    const { runId } = await createOrphanTestRun(user.userId, user.orgId, {
      prompt: "Orphan run prompt",
    });

    const request = createTestRequest(
      `http://localhost:3000/api/zero/logs/${runId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(runId);
    expect(data.prompt).toBe("Orphan run prompt");
    expect(data.agentId).toBeNull();
    expect(data.framework).toBeNull();
  });

  describe("zero token auth", () => {
    it("should return 200 for zero token with agent-run:read capability", async () => {
      const { runId } = await createTestRun(testComposeId, "Test prompt");
      await completeTestRun(user.userId, runId);

      await insertOrgMembersCacheEntry({
        orgId: user.orgId,
        userId: user.userId,
      });
      mockClerk({ userId: null });
      const token = await generateZeroToken(user.userId, "run-1", user.orgId);

      const request = createTestRequest(
        `http://localhost:3000/api/zero/logs/${runId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.id).toBe(runId);
    });

    it("should return 403 for sandbox token without agent-run:read", async () => {
      const { runId } = await createTestRun(testComposeId, "Test prompt");
      const token = await generateSandboxToken(user.userId, runId);
      mockClerk({ userId: null });

      const request = createTestRequest(
        `http://localhost:3000/api/zero/logs/${runId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const response = await GET(request);

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error.message).toContain("agent-run:read");
    });

    it("should return 401 when no auth is provided", async () => {
      const { runId } = await createTestRun(testComposeId, "Test prompt");
      mockClerk({ userId: null });

      const request = createTestRequest(
        `http://localhost:3000/api/zero/logs/${runId}`,
      );
      const response = await GET(request);

      expect(response.status).toBe(401);
    });
  });
});
