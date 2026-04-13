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
  insertTestVoiceChatPreparation,
  getTestVoiceChatPreparation,
} from "../../../../../../src/__tests__/api-test-helpers";
import { voiceChatPreparations } from "../../../../../../src/db/schema/voice-chat";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { POST } from "../route";

const context = testContext();

const CALLBACK_URL =
  "http://localhost/api/internal/callbacks/voice-chat-prepare";

describe("POST /api/internal/callbacks/voice-chat-prepare", () => {
  let user: UserContext;
  let agentId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const compose = await createTestCompose(uniqueId("vcp-cb"));
    agentId = compose.agentId;
  });

  async function setupPreparationAndRun(
    status: "completed" | "failed" = "completed",
  ) {
    const { runId } = await createTestRunInDb(user.userId, agentId, {
      status,
    });

    const prepId = await insertTestVoiceChatPreparation({
      orgId: user.orgId,
      userId: user.userId,
      agentId,
      mode: "chat",
      status: "preparing",
    });

    // Set the runId on the preparation
    initServices();
    await globalThis.services.db
      .update(voiceChatPreparations)
      .set({ runId })
      .where(eq(voiceChatPreparations.id, prepId));

    const { secret } = await createTestCallback({
      runId,
      url: CALLBACK_URL,
      payload: { preparationId: prepId },
    });

    return { runId, prepId, secret };
  }

  it("should mark in-flight preparation as failed when run completes", async () => {
    const { runId, prepId, secret } = await setupPreparationAndRun("failed");

    const request = createSignedCallbackRequest(
      CALLBACK_URL,
      {
        runId,
        status: "failed",
        error: "Run failed",
        payload: { preparationId: prepId },
      },
      secret,
    );

    const response = await POST(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);

    // Verify preparation was marked as failed
    const prep = await getTestVoiceChatPreparation(prepId);
    expect(prep!.status).toBe("failed");
  });

  it("should not change status if preparation is already ready", async () => {
    const { runId, prepId, secret } = await setupPreparationAndRun("completed");

    // First, mark the preparation as ready (simulating the CLI completing it)
    initServices();
    await globalThis.services.db
      .update(voiceChatPreparations)
      .set({ status: "ready", directiveContent: "Completed via CLI." })
      .where(eq(voiceChatPreparations.id, prepId));

    const request = createSignedCallbackRequest(
      CALLBACK_URL,
      {
        runId,
        status: "completed",
        payload: { preparationId: prepId },
      },
      secret,
    );

    const response = await POST(request);

    expect(response.status).toBe(200);

    // Verify preparation is still ready (not overwritten)
    const prep = await getTestVoiceChatPreparation(prepId);
    expect(prep!.status).toBe("ready");
    expect(prep!.directiveContent).toBe("Completed via CLI.");
  });

  it("should ignore progress notifications", async () => {
    const { runId, prepId, secret } = await setupPreparationAndRun("completed");

    const request = createSignedCallbackRequest(
      CALLBACK_URL,
      {
        runId,
        status: "progress",
        payload: { preparationId: prepId },
      },
      secret,
    );

    const response = await POST(request);

    expect(response.status).toBe(200);

    // Verify preparation is still preparing
    const prep = await getTestVoiceChatPreparation(prepId);
    expect(prep!.status).toBe("preparing");
  });

  it("should return 400 for invalid payload", async () => {
    const { runId, secret } = await setupPreparationAndRun("completed");

    const request = createSignedCallbackRequest(
      CALLBACK_URL,
      {
        runId,
        status: "completed",
        payload: { invalid: true },
      },
      secret,
    );

    const response = await POST(request);

    expect(response.status).toBe(400);
  });
});
