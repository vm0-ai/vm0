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
  createTestAgentSession,
  createTestEmailThreadSession,
  findTestEmailThreadSession,
  completeTestRun,
} from "../../../../../../../src/__tests__/api-test-helpers";
import { computeHmacSignature } from "../../../../../../../src/lib/callback/hmac";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { generateReplyToken } from "../../../../../../../src/lib/email/handlers/shared";

const context = testContext();
const mockResend = vi.mocked(new Resend(""), true);

interface ReplyCallbackPayload {
  emailThreadSessionId: string;
  inboundEmailId: string;
}

function createCallbackRequest(
  body: {
    runId: string;
    status: "completed" | "failed";
    error?: string;
    payload: ReplyCallbackPayload;
  },
  secret: string,
  options?: { invalidSignature?: boolean },
): NextRequest {
  const bodyString = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);

  const signature = options?.invalidSignature
    ? "invalid-signature"
    : computeHmacSignature(bodyString, secret, timestamp);

  return createTestRequest(
    "http://localhost/api/internal/callbacks/email/reply",
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

describe("POST /api/internal/callbacks/email/reply", () => {
  beforeEach(() => {
    context.setupMocks();
    mockResend.emails.send.mockClear();
  });

  describe("Signature Verification", () => {
    it("should reject request with invalid signature", async () => {
      const user = await context.setupUser({ prefix: "reply-sig" });
      mockClerk({ userId: user.userId });
      const { composeId } = await createTestCompose(uniqueId("reply-agent"));
      const agentSession = await createTestAgentSession(user.userId, composeId);
      const replyToken = generateReplyToken(agentSession.id);
      const emailSession = await createTestEmailThreadSession({
        userId: user.userId,
        composeId,
        agentSessionId: agentSession.id,
        replyToToken: replyToken,
      });

      const { runId } = await createTestRun(composeId, "Test prompt");

      const payload: ReplyCallbackPayload = {
        emailThreadSessionId: emailSession.id,
        inboundEmailId: "inbound-email-123",
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/email/reply",
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
  });

  describe("Email Sending", () => {
    it("should send reply email on completed run", async () => {
      const user = await context.setupUser({ prefix: "reply-ok" });
      mockClerk({ userId: user.userId });
      const { composeId } = await createTestCompose(uniqueId("reply-agent"));
      const agentSession = await createTestAgentSession(user.userId, composeId);
      const replyToken = generateReplyToken(agentSession.id);
      const emailSession = await createTestEmailThreadSession({
        userId: user.userId,
        composeId,
        agentSessionId: agentSession.id,
        replyToToken: replyToken,
        lastEmailMessageId: "<original-msg-id@vm7.bot>",
      });

      const { runId } = await createTestRun(composeId, "Email reply task");
      await completeTestRun(user.userId, runId);

      // Mock Axiom to return agent output
      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
        { eventData: { result: "Reply output" } },
      ]);

      const payload: ReplyCallbackPayload = {
        emailThreadSessionId: emailSession.id,
        inboundEmailId: "inbound-email-456",
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/email/reply",
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

      // Verify email was sent with correct fields
      expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
      const sendArgs = mockResend.emails.send.mock.calls[0]![0] as {
        from: string;
        to: string;
        subject: string;
        replyTo: string;
        headers: Record<string, string>;
      };
      expect(sendArgs.to).toBe("test@example.com");
      expect(sendArgs.replyTo).toContain("reply+");
      expect(sendArgs.headers["In-Reply-To"]).toBe("<original-msg-id@vm7.bot>");

      // Verify thread session was updated with new messageId
      const updatedSession = await findTestEmailThreadSession(replyToken);
      expect(updatedSession).not.toBeNull();
      expect(updatedSession!.lastEmailMessageId).toBe(
        "<mock-message-id@vm7.bot>",
      );
    });

    it("should send error reply email on failed run", async () => {
      const user = await context.setupUser({ prefix: "reply-fail" });
      mockClerk({ userId: user.userId });
      const { composeId } = await createTestCompose(uniqueId("reply-agent"));
      const agentSession = await createTestAgentSession(user.userId, composeId);
      const replyToken = generateReplyToken(agentSession.id);
      const emailSession = await createTestEmailThreadSession({
        userId: user.userId,
        composeId,
        agentSessionId: agentSession.id,
        replyToToken: replyToken,
      });

      const { runId } = await createTestRun(composeId, "Email reply task");

      const payload: ReplyCallbackPayload = {
        emailThreadSessionId: emailSession.id,
        inboundEmailId: "inbound-email-789",
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/email/reply",
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
        subject: string;
      };
      expect(sendArgs.to).toBe("test@example.com");
    });
  });
});
