import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import {
  createTestRunInDb,
  createTestCallback,
  createTestAgentSession,
  createTestRequest,
  createTestOrg,
  createTestCompose,
} from "../../../../../../src/__tests__/api-test-helpers";
import { computeHmacSignature } from "../../../../../../src/lib/infra/callback/hmac";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import type { PhoneCallbackPayload } from "../../../../../../src/lib/infra/callback/callback-payloads";

vi.mock("@clerk/nextjs/server");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

function createCallbackRequest(
  body: {
    runId: string;
    status: "completed" | "failed" | "progress";
    result?: Record<string, unknown>;
    error?: string;
    payload: PhoneCallbackPayload;
  },
  secret: string,
  options?: { invalidSignature?: boolean; expiredTimestamp?: boolean },
) {
  const bodyString = JSON.stringify(body);
  const timestamp = options?.expiredTimestamp
    ? Math.floor(Date.now() / 1000) - 600
    : Math.floor(Date.now() / 1000);

  const signature = options?.invalidSignature
    ? "invalid-signature"
    : computeHmacSignature(bodyString, secret, timestamp);

  return createTestRequest("http://localhost/api/internal/callbacks/phone", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-VM0-Signature": signature,
      "X-VM0-Timestamp": timestamp.toString(),
    },
    body: bodyString,
  });
}

async function setupPhoneCallback() {
  const userId = uniqueId("user");
  mockClerk({ userId });

  await createTestOrg(uniqueId("org"));
  const { composeId } = await createTestCompose("phone-test-agent");

  const { runId } = await createTestRunInDb(userId, composeId, {
    prompt: "Phone call transcript",
  });

  const orgId = uniqueId("org");
  const payload: PhoneCallbackPayload = {
    callId: `call_${Date.now()}`,
    userId,
    orgId,
    agentId: composeId,
    existingSessionId: null,
  };

  const { secret } = await createTestCallback({
    runId,
    url: "http://localhost/api/internal/callbacks/phone",
    payload: { ...payload },
  });

  return { runId, userId, composeId, orgId, payload, secret };
}

describe("POST /api/internal/callbacks/phone", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("Signature Verification", () => {
    it("should reject request with invalid signature", async () => {
      const { runId, payload, secret } = await setupPhoneCallback();

      const request = createCallbackRequest(
        { runId, status: "completed", payload },
        secret,
        { invalidSignature: true },
      );
      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toContain("signature");
    });

    it("should reject request with expired timestamp", async () => {
      const { runId, payload, secret } = await setupPhoneCallback();

      const request = createCallbackRequest(
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

  describe("Successful Callback", () => {
    it("should return 200 on completed run", async () => {
      const { runId, payload, secret } = await setupPhoneCallback();

      const request = createCallbackRequest(
        { runId, status: "completed", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });

    it("should return 200 on failed run", async () => {
      const { runId, payload, secret } = await setupPhoneCallback();

      const request = createCallbackRequest(
        { runId, status: "failed", error: "Agent run failed", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });

    it("should return 200 for progress callback without session update", async () => {
      const { runId, payload, secret } = await setupPhoneCallback();

      const request = createCallbackRequest(
        { runId, status: "progress", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });
  });

  describe("Thread Session", () => {
    it("should process callback with existing session ID", async () => {
      const { runId, payload, secret } = await setupPhoneCallback();

      const request = createCallbackRequest(
        {
          runId,
          status: "completed",
          payload: { ...payload, existingSessionId: "existing-session-123" },
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
    });

    it("should process callback and find new session when none existed", async () => {
      const { runId, payload, secret, userId, composeId } =
        await setupPhoneCallback();

      await createTestAgentSession(userId, composeId);

      const request = createCallbackRequest(
        { runId, status: "completed", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
    });
  });

  describe("Validation", () => {
    it("should reject request with invalid payload", async () => {
      const { runId, secret } = await setupPhoneCallback();

      const body = JSON.stringify({
        runId,
        status: "completed",
        payload: { callId: "call_123" },
        // Missing required fields: userId, orgId, agentId
      });
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = computeHmacSignature(body, secret, timestamp);

      const request = createTestRequest(
        "http://localhost/api/internal/callbacks/phone",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-VM0-Signature": signature,
            "X-VM0-Timestamp": timestamp.toString(),
          },
          body,
        },
      );
      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain("payload");
    });
  });
});
