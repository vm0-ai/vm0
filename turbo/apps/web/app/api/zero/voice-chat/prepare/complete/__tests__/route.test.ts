import { describe, it, expect, beforeEach } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import {
  createTestCompose,
  createTestRunInDb,
  createTestSandboxToken,
  getTestZeroAgentId,
  insertTestVoiceChatPreparation,
  getTestVoiceChatPreparation,
} from "../../../../../../../src/__tests__/api-test-helpers";
import { POST } from "../route";

const context = testContext();

function makeRequest(token: string, body?: Record<string, unknown>) {
  return new Request(
    "http://localhost:3000/api/zero/voice-chat/prepare/complete",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body ?? {}),
    },
  );
}

describe("POST /api/zero/voice-chat/prepare/complete", () => {
  let user: UserContext;
  let agentId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const compose = await createTestCompose(uniqueId("vcp-cmp"));
    agentId = await getTestZeroAgentId(user.orgId, compose.name);
  });

  async function setupPreparationWithRun(options?: {
    preparationStatus?: string;
  }) {
    const { preparationStatus = "preparing" } = options ?? {};

    const { runId } = await createTestRunInDb(user.userId, agentId, {
      status: "running",
    });

    const preparationId = await insertTestVoiceChatPreparation({
      orgId: user.orgId,
      userId: user.userId,
      agentId,
      runId,
      status: preparationStatus,
    });

    const token = await createTestSandboxToken(user.userId, runId);

    return { preparationId, runId, token };
  }

  it("should reject non-sandbox callers with 400 (no runId)", async () => {
    // When Clerk authenticates a regular user, authCtx.runId is undefined.
    // The endpoint returns 400 "must be called from a sandbox run".
    const response = await POST(
      makeRequest("invalid-token", { content: "test" }),
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("should return 400 when content is missing", async () => {
    const { token } = await setupPreparationWithRun();

    const response = await POST(makeRequest(token, {}));
    expect(response.status).toBe(400);
  });

  it("should return 400 when content is empty", async () => {
    const { token } = await setupPreparationWithRun();

    const response = await POST(makeRequest(token, { content: "" }));
    expect(response.status).toBe(400);
  });

  it("should return 404 when no preparation found for run", async () => {
    // Create a run with no linked preparation
    const { runId } = await createTestRunInDb(user.userId, agentId, {
      status: "running",
    });
    const token = await createTestSandboxToken(user.userId, runId);

    const response = await POST(
      makeRequest(token, { content: "test directive" }),
    );
    expect(response.status).toBe(404);
  });

  it("should return 400 when preparation is not in preparing status", async () => {
    const { token } = await setupPreparationWithRun({
      preparationStatus: "ready",
    });

    const response = await POST(
      makeRequest(token, { content: "test directive" }),
    );
    expect(response.status).toBe(400);
  });

  it("should complete preparation successfully", async () => {
    const { preparationId, token } = await setupPreparationWithRun();

    const response = await POST(
      makeRequest(token, { content: "User is a backend engineer..." }),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe(preparationId);
    expect(data.status).toBe("ready");

    // Verify database state
    const prep = await getTestVoiceChatPreparation(preparationId);
    expect(prep?.status).toBe("ready");
    expect(prep?.directiveContent).toBe("User is a backend engineer...");
  });
});
