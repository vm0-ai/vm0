import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  completeTestRun,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

describe("GET /api/platform/logs/[id]", () => {
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
      `http://localhost:3000/api/platform/logs/${runId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toBe("Not authenticated");
  });

  it("should return 400 for invalid UUID format", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/platform/logs/invalid-uuid",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should return 404 for non-existent run", async () => {
    const nonExistentId = randomUUID();
    const request = createTestRequest(
      `http://localhost:3000/api/platform/logs/${nonExistentId}`,
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
      `http://localhost:3000/api/platform/logs/${otherRun.runId}`,
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
      `http://localhost:3000/api/platform/logs/${runId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(runId);
    expect(data.agentName).toContain("logs-detail");
    expect(data.framework).toBe("claude-code");
    expect(data.status).toBe("completed");
    expect(data.prompt).toBe("Test prompt");
    expect(data.error).toBeNull();
    expect(data.createdAt).toBeDefined();
    expect(data.completedAt).toBeDefined();
    expect(data.sessionId).toBeDefined();
  });

  it("should handle running run status", async () => {
    // Create run but don't complete it (stays in running status)
    const { runId, status } = await createTestRun(testComposeId, "Test prompt");

    // Run should be in running state
    expect(status).toBe("running");

    const request = createTestRequest(
      `http://localhost:3000/api/platform/logs/${runId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(runId);
    expect(data.status).toBe("running");
    expect(data.sessionId).toBeNull();
    expect(data.completedAt).toBeNull();
  });

  it("should handle failed run with error message", async () => {
    // Make sandbox creation fail to create a failed run
    vi.mocked(
      (await import("@e2b/code-interpreter")).Sandbox.create,
    ).mockRejectedValueOnce(new Error("Sandbox creation failed"));

    const { runId, status } = await createTestRun(testComposeId, "Test prompt");

    // Run should be in failed state
    expect(status).toBe("failed");

    const request = createTestRequest(
      `http://localhost:3000/api/platform/logs/${runId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe("failed");
    expect(data.error).toBeDefined();
  });
});
