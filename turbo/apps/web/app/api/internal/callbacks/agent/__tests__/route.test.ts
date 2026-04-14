import { describe, it, expect, beforeEach, vi } from "vitest";
import { HttpResponse } from "msw";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import {
  createTestCompose,
  createTestRunInDb,
  createTestCallback,
  createSignedCallbackRequest,
  findTestZeroRun,
} from "../../../../../../src/__tests__/api-test-helpers";
import { createTestZeroAgent } from "../../../../../../src/__tests__/db-test-seeders/agents";
import { reloadEnv } from "../../../../../../src/env";
import { POST } from "../route";
import { http } from "../../../../../../src/__tests__/msw";
import { server } from "../../../../../../src/mocks/server";

const context = testContext();

describe("POST /api/internal/callbacks/agent", () => {
  let composeId: string;
  let userId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    userId = user.userId;
    const agentName = uniqueId("agent");
    composeId = (await createTestCompose(agentName)).composeId;
    await createTestZeroAgent(user.orgId, agentName, {});
  });

  async function setupAgentRun() {
    const { runId } = await createTestRunInDb(userId, composeId, {
      prompt: "Delegate this task to the other agent",
      triggerSource: "agent",
    });
    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/agent",
      payload: {},
    });
    return { runId, secret };
  }

  describe("Signature Verification", () => {
    it("should reject request with invalid signature", async () => {
      const { runId, secret } = await setupAgentRun();

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/agent",
        {
          runId,
          status: "completed",
          payload: {},
        },
        secret,
        { invalidSignature: true },
      );
      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it("should reject request with unknown runId", async () => {
      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/agent",
        {
          runId: "00000000-0000-0000-0000-000000000000",
          status: "completed",
          payload: {},
        },
        "fake-secret",
      );
      const response = await POST(request);

      expect(response.status).toBe(404);
    });
  });

  describe("Progress Callback", () => {
    it("should return 200 without affecting DB for progress notifications", async () => {
      const { runId, secret } = await setupAgentRun();

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/agent",
        {
          runId,
          status: "progress",
          payload: {},
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Summary should remain null — no DB write occurred
      const zeroRun = await findTestZeroRun(runId);
      expect(zeroRun?.summary).toBeNull();
    });
  });

  describe("Completed Callback", () => {
    it("should generate and persist summary on successful completion", async () => {
      const { runId, secret } = await setupAgentRun();

      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
        {
          eventType: "result",
          eventData: { result: "Task completed successfully." },
        },
      ]);

      vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
      reloadEnv();

      const { handler } = http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        () => {
          return HttpResponse.json({
            choices: [{ message: { content: "Agent delegated the task." } }],
          });
        },
      );
      server.use(handler);

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/agent",
        {
          runId,
          status: "completed",
          payload: {},
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify summary was persisted
      const zeroRun = await findTestZeroRun(runId);
      expect(zeroRun?.summary).not.toBeNull();
      expect(zeroRun?.summary).toBe("Agent delegated the task.");
    });

    it("should return 200 without summary when OPENROUTER_API_KEY is absent", async () => {
      const { runId, secret } = await setupAgentRun();

      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
        {
          eventType: "result",
          eventData: { result: "Task completed successfully." },
        },
      ]);

      // Without OPENROUTER_API_KEY, saveRunSummary is a no-op and returns null
      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/agent",
        {
          runId,
          status: "completed",
          payload: {},
        },
        secret,
      );

      const response = await POST(request);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Summary should remain null — no API key means no LLM call
      const zeroRun = await findTestZeroRun(runId);
      expect(zeroRun?.summary).toBeNull();
    });
  });

  describe("Failed Callback", () => {
    it("should return 200 without generating summary for failed runs", async () => {
      const { runId, secret } = await setupAgentRun();

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/agent",
        {
          runId,
          status: "failed",
          error: "Agent run failed",
          payload: {},
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Summary should remain null — we don't summarize failures
      const zeroRun = await findTestZeroRun(runId);
      expect(zeroRun?.summary).toBeNull();
    });
  });
});
