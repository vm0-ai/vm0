import { describe, it, expect, beforeEach, vi } from "vitest";

import { Resend } from "resend";
import { NextRequest } from "next/server";
import { POST } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import {
  createTestCompose,
  createTestRun,
  createTestCallback,
  createTestRequest,
  completeTestRun,
  findTestEmailThreadSession,
} from "../../../../../../../src/__tests__/api-test-helpers";
import { computeHmacSignature } from "../../../../../../../src/lib/callback/hmac";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { generateReplyToken } from "../../../../../../../src/lib/email/handlers/shared";

const context = testContext();
const mockResend = vi.mocked(new Resend(""), true);

interface TriggerCallbackPayload {
  senderEmail: string;
  composeId: string;
  userId: string;
  inboundEmailId: string;
  replyToken: string;
  inboundMessageId?: string;
  inboundReferences?: string;
  subject?: string;
  triggerLocalPart?: string;
}

function createCallbackRequest(
  body: {
    runId: string;
    status: "completed" | "failed";
    error?: string;
    payload: TriggerCallbackPayload;
  },
  secret: string,
  options?: { invalidSignature?: boolean; expiredTimestamp?: boolean },
): NextRequest {
  const bodyString = JSON.stringify(body);
  const timestamp = options?.expiredTimestamp
    ? Math.floor(Date.now() / 1000) - 600
    : Math.floor(Date.now() / 1000);

  const signature = options?.invalidSignature
    ? "invalid-signature"
    : computeHmacSignature(bodyString, secret, timestamp);

  return createTestRequest(
    "http://localhost/api/internal/callbacks/email/trigger",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-VM0-Signature": signature,
        "X-VM0-Timestamp": timestamp.toString(),
      },
      body: bodyString,
    },
  );
}

describe("POST /api/internal/callbacks/email/trigger", () => {
  beforeEach(() => {
    context.setupMocks();
    mockResend.emails.send.mockClear();
  });

  describe("Signature Verification", () => {
    it("should reject request with invalid signature", async () => {
      const user = await context.setupUser({ prefix: "trigger-sig" });
      mockClerk({ userId: user.userId });
      const { composeId } = await createTestCompose(uniqueId("trigger-agent"));
      const { runId } = await createTestRun(composeId, "Test prompt");

      const replyToken = generateReplyToken(crypto.randomUUID());
      const payload: TriggerCallbackPayload = {
        senderEmail: "sender@example.com",
        composeId,
        userId: user.userId,
        inboundEmailId: "email-123",
        replyToken,
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/email/trigger",
        payload: { ...payload },
      });

      const request = createCallbackRequest(
        { runId, status: "completed", payload },
        secret,
        { invalidSignature: true },
      );
      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it("should reject request with expired timestamp", async () => {
      const user = await context.setupUser({ prefix: "trigger-exp" });
      mockClerk({ userId: user.userId });
      const { composeId } = await createTestCompose(uniqueId("trigger-agent"));
      const { runId } = await createTestRun(composeId, "Test prompt");

      const replyToken = generateReplyToken(crypto.randomUUID());
      const payload: TriggerCallbackPayload = {
        senderEmail: "sender@example.com",
        composeId,
        userId: user.userId,
        inboundEmailId: "email-123",
        replyToken,
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/email/trigger",
        payload: { ...payload },
      });

      const request = createCallbackRequest(
        { runId, status: "completed", payload },
        secret,
        { expiredTimestamp: true },
      );
      const response = await POST(request);

      expect(response.status).toBe(401);
    });
  });

  describe("Email Sending", () => {
    it("should send response email with mirrored from address and original subject", async () => {
      const user = await context.setupUser({ prefix: "trigger-ok" });
      mockClerk({ userId: user.userId });
      const agentName = uniqueId("trigger-agent");
      const { composeId } = await createTestCompose(agentName);
      const { runId } = await createTestRun(composeId, "Test prompt");
      await completeTestRun(user.userId, runId);

      const replyToken = generateReplyToken(crypto.randomUUID());
      const senderEmail = "sender@example.com";
      const triggerLocalPart = `my-scope+${agentName}`;
      const payload: TriggerCallbackPayload = {
        senderEmail,
        composeId,
        userId: user.userId,
        inboundEmailId: "email-123",
        replyToken,
        inboundMessageId: "<orig-msg-id@example.com>",
        subject: "Help me with this",
        triggerLocalPart,
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/email/trigger",
        payload: { ...payload },
      });

      const request = createCallbackRequest(
        { runId, status: "completed", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
      const sendArgs = mockResend.emails.send.mock.calls[0]![0] as {
        from: string;
        to: string;
        subject: string;
        replyTo: string;
        headers: Record<string, string>;
      };
      expect(sendArgs.to).toBe(senderEmail);
      expect(sendArgs.from).toContain(triggerLocalPart);
      expect(sendArgs.subject).toBe("Re: Help me with this");
      expect(sendArgs.replyTo).toContain("reply+");
      expect(sendArgs.headers).toMatchObject({
        "In-Reply-To": "<orig-msg-id@example.com>",
        References: "<orig-msg-id@example.com>",
      });
    });

    it("should strip existing Re: prefix to prevent duplication", async () => {
      const user = await context.setupUser({ prefix: "trigger-re" });
      mockClerk({ userId: user.userId });
      const agentName = uniqueId("re-agent");
      const { composeId } = await createTestCompose(agentName);
      const { runId } = await createTestRun(composeId, "Test prompt");
      await completeTestRun(user.userId, runId);

      const replyToken = generateReplyToken(crypto.randomUUID());
      const payload: TriggerCallbackPayload = {
        senderEmail: "sender@example.com",
        composeId,
        userId: user.userId,
        inboundEmailId: "email-456",
        replyToken,
        subject: "Re: Original Topic",
        triggerLocalPart: agentName,
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/email/trigger",
        payload: { ...payload },
      });

      const request = createCallbackRequest(
        { runId, status: "completed", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);

      expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
      const sendArgs = mockResend.emails.send.mock.calls[0]![0] as {
        subject: string;
        from: string;
      };
      expect(sendArgs.subject).toBe("Re: Original Topic");
      expect(sendArgs.from).toContain(agentName);
    });

    it("should send error email for failed trigger run", async () => {
      const user = await context.setupUser({ prefix: "trigger-fail" });
      mockClerk({ userId: user.userId });
      const agentName = uniqueId("fail-agent");
      const { composeId } = await createTestCompose(agentName);
      const { runId } = await createTestRun(composeId, "Test prompt");

      const replyToken = generateReplyToken(crypto.randomUUID());
      const senderEmail = "sender@example.com";
      const payload: TriggerCallbackPayload = {
        senderEmail,
        composeId,
        userId: user.userId,
        inboundEmailId: "email-123",
        replyToken,
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/email/trigger",
        payload: { ...payload },
      });

      const request = createCallbackRequest(
        { runId, status: "failed", error: "Agent crashed", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);

      expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
      const sendArgs = mockResend.emails.send.mock.calls[0]![0] as {
        to: string;
      };
      expect(sendArgs.to).toBe(senderEmail);
    });
  });

  describe("Session Creation", () => {
    it("should create email thread session for reply continuity", async () => {
      const user = await context.setupUser({ prefix: "trigger-session" });
      mockClerk({ userId: user.userId });
      const agentName = uniqueId("session-agent");
      const { composeId } = await createTestCompose(agentName);
      const { runId } = await createTestRun(composeId, "Test prompt");
      await completeTestRun(user.userId, runId);

      const replyToken = generateReplyToken(crypto.randomUUID());
      const senderEmail = "sender@example.com";
      const payload: TriggerCallbackPayload = {
        senderEmail,
        composeId,
        userId: user.userId,
        inboundEmailId: "email-123",
        replyToken,
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/email/trigger",
        payload: { ...payload },
      });

      const request = createCallbackRequest(
        { runId, status: "completed", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);

      // Verify email thread session was created
      const session = await findTestEmailThreadSession(replyToken);
      expect(session).toBeDefined();
      expect(session!.userId).toBe(user.userId);
      expect(session!.composeId).toBe(composeId);
      expect(session!.replyToToken).toBe(replyToken);
    });
  });
});
