import { describe, it, expect, beforeEach, vi } from "vitest";

import { Resend } from "resend";
import { POST } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import {
  createTestCompose,
  createTestRun,
  createTestCallback,
  completeTestRun,
  findTestEmailThreadSession,
  createSignedCallbackRequest,
  generateTestReplyToken,
} from "../../../../../../../src/__tests__/api-test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";

const context = testContext();
const mockResend = vi.mocked(new Resend(""), true);

interface TriggerCallbackPayload {
  senderEmail: string;
  agentId: string;
  userId: string;
  inboundEmailId: string;
  replyToken: string;
  inboundMessageId?: string;
  inboundReferences?: string;
  subject?: string;
  replyRecipientTo?: string[];
  replyRecipientCc?: string[];
}

describe("POST /api/zero/email/callbacks/trigger", () => {
  beforeEach(() => {
    context.setupMocks();
    mockResend.emails.send.mockClear();
  });

  describe("Signature Verification", () => {
    it("should reject request with invalid signature", async () => {
      const user = await context.setupUser({ prefix: "trigger-sig" });
      mockClerk({ userId: user.userId });
      const { composeId, agentId } = await createTestCompose(
        uniqueId("trigger-agent"),
      );
      const { runId } = await createTestRun(composeId, "Test prompt");

      const replyToken = generateTestReplyToken(crypto.randomUUID());
      const payload: TriggerCallbackPayload = {
        senderEmail: "sender@example.com",
        agentId,
        userId: user.userId,
        inboundEmailId: "email-123",
        replyToken,
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/zero/email/callbacks/trigger",
        payload: { ...payload },
      });

      const request = createSignedCallbackRequest(
        "http://localhost/api/zero/email/callbacks/trigger",
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
      const { composeId, agentId } = await createTestCompose(
        uniqueId("trigger-agent"),
      );
      const { runId } = await createTestRun(composeId, "Test prompt");

      const replyToken = generateTestReplyToken(crypto.randomUUID());
      const payload: TriggerCallbackPayload = {
        senderEmail: "sender@example.com",
        agentId,
        userId: user.userId,
        inboundEmailId: "email-123",
        replyToken,
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/zero/email/callbacks/trigger",
        payload: { ...payload },
      });

      const request = createSignedCallbackRequest(
        "http://localhost/api/zero/email/callbacks/trigger",
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
      const { composeId, agentId } = await createTestCompose(agentName);
      const { runId } = await createTestRun(composeId, "Test prompt");
      await completeTestRun(user.userId, runId);

      const replyToken = generateTestReplyToken(crypto.randomUUID());
      const senderEmail = "sender@example.com";
      const payload: TriggerCallbackPayload = {
        senderEmail,
        agentId,
        userId: user.userId,
        inboundEmailId: "email-123",
        replyToken,
        inboundMessageId: "<orig-msg-id@example.com>",
        subject: "Help me with this",
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/zero/email/callbacks/trigger",
        payload: { ...payload },
      });

      const request = createSignedCallbackRequest(
        "http://localhost/api/zero/email/callbacks/trigger",
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
      expect(sendArgs.from).toMatch(/^Zero <org-[a-f0-9]+@/);
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
      const { composeId, agentId } = await createTestCompose(agentName);
      const { runId } = await createTestRun(composeId, "Test prompt");
      await completeTestRun(user.userId, runId);

      const replyToken = generateTestReplyToken(crypto.randomUUID());
      const payload: TriggerCallbackPayload = {
        senderEmail: "sender@example.com",
        agentId,
        userId: user.userId,
        inboundEmailId: "email-456",
        replyToken,
        subject: "Re: Original Topic",
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/zero/email/callbacks/trigger",
        payload: { ...payload },
      });

      const request = createSignedCallbackRequest(
        "http://localhost/api/zero/email/callbacks/trigger",
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
      expect(sendArgs.from).toMatch(/^Zero <org-[a-f0-9]+@/);
    });

    it("should send to multiple recipients when replyRecipientTo is provided", async () => {
      const user = await context.setupUser({ prefix: "trigger-replyall" });
      mockClerk({ userId: user.userId });
      const agentName = uniqueId("replyall-agent");
      const { composeId, agentId } = await createTestCompose(agentName);
      const { runId } = await createTestRun(composeId, "Test prompt");
      await completeTestRun(user.userId, runId);

      const replyToken = generateTestReplyToken(crypto.randomUUID());
      const payload: TriggerCallbackPayload = {
        senderEmail: "user-a@example.com",
        agentId,
        userId: user.userId,
        inboundEmailId: "email-replyall",
        replyToken,
        subject: "Group discussion",
        replyRecipientTo: ["user-a@example.com", "user-b@example.com"],
        replyRecipientCc: ["user-c@example.com"],
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/zero/email/callbacks/trigger",
        payload: { ...payload },
      });

      const request = createSignedCallbackRequest(
        "http://localhost/api/zero/email/callbacks/trigger",
        { runId, status: "completed", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);

      expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
      const sendArgs = mockResend.emails.send.mock.calls[0]![0] as {
        to: string | string[];
        cc: string | string[];
      };
      expect(sendArgs.to).toEqual(["user-a@example.com", "user-b@example.com"]);
      expect(sendArgs.cc).toEqual(["user-c@example.com"]);
    });

    it("should fall back to senderEmail when replyRecipientTo is not provided", async () => {
      const user = await context.setupUser({ prefix: "trigger-fallback" });
      mockClerk({ userId: user.userId });
      const agentName = uniqueId("fallback-agent");
      const { composeId, agentId } = await createTestCompose(agentName);
      const { runId } = await createTestRun(composeId, "Test prompt");
      await completeTestRun(user.userId, runId);

      const replyToken = generateTestReplyToken(crypto.randomUUID());
      const senderEmail = "sender@example.com";
      const payload: TriggerCallbackPayload = {
        senderEmail,
        agentId,
        userId: user.userId,
        inboundEmailId: "email-fallback",
        replyToken,
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/zero/email/callbacks/trigger",
        payload: { ...payload },
      });

      const request = createSignedCallbackRequest(
        "http://localhost/api/zero/email/callbacks/trigger",
        { runId, status: "completed", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);

      expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
      const sendArgs = mockResend.emails.send.mock.calls[0]![0] as {
        to: string | string[];
        cc: unknown;
      };
      expect(sendArgs.to).toBe(senderEmail);
      expect(sendArgs.cc).toBeUndefined();
    });

    it("should send error email for failed trigger run", async () => {
      const user = await context.setupUser({ prefix: "trigger-fail" });
      mockClerk({ userId: user.userId });
      const agentName = uniqueId("fail-agent");
      const { composeId, agentId } = await createTestCompose(agentName);
      const { runId } = await createTestRun(composeId, "Test prompt");

      const replyToken = generateTestReplyToken(crypto.randomUUID());
      const senderEmail = "sender@example.com";
      const payload: TriggerCallbackPayload = {
        senderEmail,
        agentId,
        userId: user.userId,
        inboundEmailId: "email-123",
        replyToken,
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/zero/email/callbacks/trigger",
        payload: { ...payload },
      });

      const request = createSignedCallbackRequest(
        "http://localhost/api/zero/email/callbacks/trigger",
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

  describe("Progress Callback", () => {
    it("should no-op on progress and not send any email", async () => {
      const user = await context.setupUser({ prefix: "trigger-progress" });
      mockClerk({ userId: user.userId });
      const agentName = uniqueId("progress-agent");
      const { composeId, agentId } = await createTestCompose(agentName);
      const { runId } = await createTestRun(composeId, "Test prompt");

      const replyToken = generateTestReplyToken(crypto.randomUUID());
      const payload: TriggerCallbackPayload = {
        senderEmail: "sender@example.com",
        agentId,
        userId: user.userId,
        inboundEmailId: "email-progress",
        replyToken,
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/zero/email/callbacks/trigger",
        payload: { ...payload },
      });

      const request = createSignedCallbackRequest(
        "http://localhost/api/zero/email/callbacks/trigger",
        { runId, status: "progress", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // No email should be sent for progress notifications
      expect(mockResend.emails.send).not.toHaveBeenCalled();
    });
  });

  describe("Session Creation", () => {
    it("should create email thread session for reply continuity", async () => {
      const user = await context.setupUser({ prefix: "trigger-session" });
      mockClerk({ userId: user.userId });
      const agentName = uniqueId("session-agent");
      const { composeId, agentId } = await createTestCompose(agentName);
      const { runId } = await createTestRun(composeId, "Test prompt");
      await completeTestRun(user.userId, runId);

      const replyToken = generateTestReplyToken(crypto.randomUUID());
      const senderEmail = "sender@example.com";
      const payload: TriggerCallbackPayload = {
        senderEmail,
        agentId,
        userId: user.userId,
        inboundEmailId: "email-123",
        replyToken,
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/zero/email/callbacks/trigger",
        payload: { ...payload },
      });

      const request = createSignedCallbackRequest(
        "http://localhost/api/zero/email/callbacks/trigger",
        { runId, status: "completed", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);

      // Verify email thread session was created
      const session = await findTestEmailThreadSession(replyToken);
      expect(session).toBeDefined();
      expect(session!.userId).toBe(user.userId);
      expect(session!.agentId).toBe(agentId);
      expect(session!.replyToToken).toBe(replyToken);
    });
  });
});
