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

describe("GET /api/agent/sessions/:id", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(
      `session-${randomUUID().slice(0, 8)}`,
    );
    testComposeId = composeId;
  });

  it("should return session with all fields", async () => {
    // Create run and complete it (creates session via checkpoint)
    const { runId } = await createTestRun(testComposeId, "Test session");
    const { agentSessionId } = await completeTestRun(user.userId, runId);

    const request = createTestRequest(
      `http://localhost:3000/api/agent/sessions/${agentSessionId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(agentSessionId);
    expect(data.agentComposeId).toBe(testComposeId);
    expect(data.agentComposeVersionId).toBeDefined();
    expect(data.createdAt).toBeDefined();
    expect(data.updatedAt).toBeDefined();
  });

  it("should return 404 for non-existent session", async () => {
    const nonExistentId = randomUUID();
    const request = createTestRequest(
      `http://localhost:3000/api/agent/sessions/${nonExistentId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
    expect(data.error.message).toContain("Session not found");
  });

  it("should return 403 when accessing another user's session", async () => {
    // Create another user and their compose/session
    const otherUser = await context.setupUser({ prefix: "other" });
    const { composeId: otherComposeId } = await createTestCompose(
      `other-session-${Date.now()}`,
    );
    const { runId: otherRunId } = await createTestRun(
      otherComposeId,
      "Other user run",
    );
    const { agentSessionId: otherSessionId } = await completeTestRun(
      otherUser.userId,
      otherRunId,
    );

    // Switch back to original user
    mockClerk({ userId: user.userId });

    // Try to access other user's session
    const request = createTestRequest(
      `http://localhost:3000/api/agent/sessions/${otherSessionId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error.code).toBe("FORBIDDEN");
  });

  it("should return 401 when not authenticated", async () => {
    // Create run and complete it (creates session)
    const { runId } = await createTestRun(testComposeId, "Test session");
    const { agentSessionId } = await completeTestRun(user.userId, runId);

    // Mock Clerk to return no user
    mockClerk({ userId: null });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/sessions/${agentSessionId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });
});
