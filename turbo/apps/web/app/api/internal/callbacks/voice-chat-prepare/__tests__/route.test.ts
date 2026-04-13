import { describe, it, expect, beforeEach } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import {
  createTestCompose,
  createTestCallback,
  createTestRunInDb,
  createSignedCallbackRequest,
  getTestZeroAgentId,
  insertTestVoiceChatPreparation,
  getTestVoiceChatPreparation,
} from "../../../../../../src/__tests__/api-test-helpers";
import { POST } from "../route";

const context = testContext();

describe("POST /api/internal/callbacks/voice-chat-prepare", () => {
  let user: UserContext;
  let agentId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const compose = await createTestCompose(uniqueId("vcp-cb"));
    agentId = await getTestZeroAgentId(user.orgId, compose.name);
  });

  async function setupPreparationAndRun(options?: {
    preparationStatus?: string;
    runStatus?: "completed" | "failed";
  }) {
    const { preparationStatus = "preparing", runStatus = "completed" } =
      options ?? {};

    const { runId } = await createTestRunInDb(user.userId, agentId, {
      status: runStatus,
    });

    const preparationId = await insertTestVoiceChatPreparation({
      orgId: user.orgId,
      userId: user.userId,
      agentId,
      runId,
      status: preparationStatus,
    });

    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/voice-chat-prepare",
      payload: { preparationId },
    });

    return { preparationId, runId, secret };
  }

  it("should return 200 for progress status without changing preparation", async () => {
    const { preparationId, runId, secret } = await setupPreparationAndRun();

    const response = await POST(
      createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/voice-chat-prepare",
        {
          runId,
          status: "progress",
          payload: { preparationId },
        },
        secret,
      ),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);

    // Preparation should still be "preparing"
    const prep = await getTestVoiceChatPreparation(preparationId);
    expect(prep?.status).toBe("preparing");
  });

  it("should mark preparation as failed on non-completed terminal state", async () => {
    const { preparationId, runId, secret } = await setupPreparationAndRun({
      runStatus: "failed",
    });

    const response = await POST(
      createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/voice-chat-prepare",
        {
          runId,
          status: "failed",
          error: "Run crashed",
          payload: { preparationId },
        },
        secret,
      ),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);

    // Preparation should now be "failed"
    const prep = await getTestVoiceChatPreparation(preparationId);
    expect(prep?.status).toBe("failed");
  });

  it("should not change preparation on completed status (CLI handles success)", async () => {
    const { preparationId, runId, secret } = await setupPreparationAndRun();

    const response = await POST(
      createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/voice-chat-prepare",
        {
          runId,
          status: "completed",
          payload: { preparationId },
        },
        secret,
      ),
    );

    expect(response.status).toBe(200);

    // On "completed", the callback is a no-op — the CLI `prepare` command
    // already marked the preparation as "ready" via the complete endpoint.
    const prep = await getTestVoiceChatPreparation(preparationId);
    expect(prep?.status).toBe("preparing");
  });

  it("should return 400 for invalid payload", async () => {
    const { runId, secret } = await setupPreparationAndRun();

    const response = await POST(
      createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/voice-chat-prepare",
        {
          runId,
          status: "completed",
          payload: { invalid: true },
        },
        secret,
      ),
    );

    expect(response.status).toBe(400);
  });

  it("should return 401 for invalid signature", async () => {
    const { preparationId, runId, secret } = await setupPreparationAndRun();

    const response = await POST(
      createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/voice-chat-prepare",
        {
          runId,
          status: "completed",
          payload: { preparationId },
        },
        secret,
        { invalidSignature: true },
      ),
    );

    expect(response.status).toBe(401);
  });
});
