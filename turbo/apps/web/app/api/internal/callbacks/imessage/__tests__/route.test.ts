import { describe, it, expect, beforeEach, vi } from "vitest";
import { HttpResponse } from "msw";
import { POST } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import {
  createTestCallback,
  createTestAgentSession,
  createTestCompose,
  createSignedCallbackRequest,
} from "../../../../../../src/__tests__/api-test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { seedTestRun } from "../../../../../../src/__tests__/db-test-seeders/runs";
import { server } from "../../../../../../src/mocks/server";
import { http } from "../../../../../../src/__tests__/msw";
import type { IMessageCallbackPayload } from "../../../../../../src/lib/infra/callback/callback-payloads";

vi.mock("@clerk/nextjs/server");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

// Register MSW handler for AgentPhone send-message endpoint used by sendIMessage()
const { handler: agentphoneSendMessage } = http.post(
  "https://api.agentphone.to/v1/messages",
  () => {
    return HttpResponse.json({ id: "msg_test", status: "sent" });
  },
);

async function setupIMessageCallback() {
  const userId = uniqueId("user");
  mockClerk({ userId });

  const { composeId } = await createTestCompose("imessage-test-agent");
  const { runId } = await seedTestRun(userId, composeId, {
    prompt: "Hello from iMessage",
  });

  const orgId = uniqueId("org");
  const payload: IMessageCallbackPayload = {
    messageId: `msg_${Date.now()}`,
    fromNumber: "+14155551234",
    userId,
    orgId,
    agentId: composeId,
    agentphoneAgentId: uniqueId("ap-agent"),
    existingSessionId: null,
  };

  const { secret } = await createTestCallback({
    runId,
    url: "http://localhost/api/internal/callbacks/imessage",
    payload: { ...payload },
  });

  return { runId, userId, composeId, orgId, payload, secret };
}

describe("POST /api/internal/callbacks/imessage", () => {
  beforeEach(() => {
    context.setupMocks();
    server.use(agentphoneSendMessage);
  });

  describe("Signature Verification", () => {
    it("rejects requests with an invalid signature", async () => {
      const { runId, payload, secret } = await setupIMessageCallback();

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/imessage",
        { runId, status: "completed", payload },
        secret,
        { invalidSignature: true },
      );
      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toContain("signature");
    });

    it("rejects requests with an expired timestamp", async () => {
      const { runId, payload, secret } = await setupIMessageCallback();

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/imessage",
        { runId, status: "completed", payload },
        secret,
        { expiredTimestamp: true },
      );
      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toContain("expired");
    });
  });

  describe("Validation", () => {
    it("returns 400 for a payload missing required fields", async () => {
      const { runId, secret } = await setupIMessageCallback();

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/imessage",
        {
          runId,
          status: "completed",
          // Missing fromNumber, userId, orgId, agentId, agentphoneAgentId
          payload: { messageId: "msg_123" },
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain("payload");
    });
  });

  describe("Progress callbacks", () => {
    it("returns 200 and ignores progress status (no iMessage sent)", async () => {
      const { runId, payload, secret } = await setupIMessageCallback();

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/imessage",
        { runId, status: "progress", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });
  });

  describe("Completed run", () => {
    it("returns 200 when the run completes", async () => {
      const { runId, payload, secret } = await setupIMessageCallback();

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/imessage",
        { runId, status: "completed", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });

    it("returns 200 with an existing session ID", async () => {
      const { runId, payload, secret, userId, composeId } =
        await setupIMessageCallback();

      const { id: sessionId } = await createTestAgentSession(userId, composeId);

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/imessage",
        {
          runId,
          status: "completed",
          payload: { ...payload, existingSessionId: sessionId },
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
    });
  });

  describe("Failed run", () => {
    it("returns 200 on a failed run (error logged, no reply sent)", async () => {
      const { runId, payload, secret } = await setupIMessageCallback();

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/imessage",
        { runId, status: "failed", error: "Agent timed out", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });
  });
});
