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

describe("GET /api/agent/checkpoints/:id", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    // Create test compose
    const { composeId } = await createTestCompose(`checkpoint-${Date.now()}`);
    testComposeId = composeId;
  });

  it("should return checkpoint with agentComposeSnapshot including secretNames", async () => {
    // Create run and complete it (creates checkpoint)
    const { runId } = await createTestRun(testComposeId, "Test checkpoint");
    const { checkpointId } = await completeTestRun(user.userId, runId);

    const request = createTestRequest(
      `http://localhost:3000/api/agent/checkpoints/${checkpointId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(checkpointId);
    expect(data.runId).toBe(runId);
    expect(data.conversationId).toBeDefined();
    expect(data.agentComposeSnapshot).toBeDefined();
    expect(data.agentComposeSnapshot.agentComposeVersionId).toBeDefined();
    expect(data.createdAt).toBeDefined();
  });

  it("should return 404 for non-existent checkpoint", async () => {
    const nonExistentId = randomUUID();
    const request = createTestRequest(
      `http://localhost:3000/api/agent/checkpoints/${nonExistentId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
    expect(data.error.message).toContain("Checkpoint not found");
  });

  it("should return 403 when accessing another user's checkpoint", async () => {
    // Create another user with their own compose and run
    const otherUser = await context.setupUser({ prefix: "other" });
    const { composeId: otherComposeId } = await createTestCompose(
      `other-checkpoint-${Date.now()}`,
    );

    // Create and complete run for other user (creates checkpoint)
    const otherRun = await createTestRun(otherComposeId, "Other user run");
    const { checkpointId: otherCheckpointId } = await completeTestRun(
      otherUser.userId,
      otherRun.runId,
    );

    // Switch back to original user
    mockClerk({ userId: user.userId });

    // Try to access other user's checkpoint
    const request = createTestRequest(
      `http://localhost:3000/api/agent/checkpoints/${otherCheckpointId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error.code).toBe("FORBIDDEN");
  });

  it("should return 401 when not authenticated", async () => {
    // Create run and complete it (creates checkpoint)
    const { runId } = await createTestRun(testComposeId, "Test checkpoint");
    const { checkpointId } = await completeTestRun(user.userId, runId);

    // Mock Clerk to return no user
    mockClerk({ userId: null });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/checkpoints/${checkpointId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });
});
