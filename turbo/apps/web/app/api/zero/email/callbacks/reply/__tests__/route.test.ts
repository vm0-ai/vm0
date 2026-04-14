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
  createTestAgentSession,
  completeTestRun,
  createSignedCallbackRequest,
} from "../../../../../../../src/__tests__/api-test-helpers";
import { createTestEmailThreadSession } from "../../../../../../../src/__tests__/db-test-seeders/email";
import { findTestEmailThreadSession } from "../../../../../../../src/__tests__/db-test-assertions/email";
import { generateReplyToken } from "../../../../../../../src/lib/zero/email/handlers/shared";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";

const context = testContext();
const mockResend = vi.mocked(new Resend(""), true);

interface ReplyCallbackPayload {
  emailThreadSessionId: string;
  inboundEmailId: string;
  inboundMessageId?: string;
  inboundReferences?: string;
  replyRecipientTo?: string[];
  replyRecipientCc?: string[];
}

describe("POST /api/zero/email/callbacks/reply", () => {
  beforeEach(() => {
    context.setupMocks();
    mockResend.emails.send.mockClear();
  });

  describe("Signature Verification", () => {
    it("should reject request with invalid signature", async () => {
      const user = await context.setupUser({ prefix: "reply-sig" });
      mockClerk({ userId: user.userId });
      const { composeId, agentId } = await createTestCompose(
        uniqueId("reply-agent"),
      );
      const agentSession = await createTestAgentSession(user.userId, composeId);
      const replyToken = generateReplyToken(agentSession.id);
      const emailSession = await createTestEmailThreadSession({
        userId: user.userId,
        agentId,
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
        url: "http://localhost/api/zero/email/callbacks/reply",
        payload: { ...payload },
      });

      const request = createSignedCallbackRequest(
        "http://localhost/api/zero/email/callbacks/reply",
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
      const { composeId, agentId } = await createTestCompose(
        uniqueId("reply-agent"),
      );
      const agentSession = await createTestAgentSession(user.userId, composeId);
      const replyToken = generateReplyToken(agentSession.id);
      const emailSession = await createTestEmailThreadSession({
        userId: user.userId,
        agentId,
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
        inboundMessageId: "<user-reply@mail.example.com>",
        inboundReferences:
          "<orig-user-msg@mail.example.com> <original-msg-id@vm7.bot>",
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/zero/email/callbacks/reply",
        payload: { ...payload },
      });

      const request = createSignedCallbackRequest(
        "http://localhost/api/zero/email/callbacks/reply",
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
      expect(sendArgs.from).toMatch(/^Zero <org-[a-f0-9]+@/);
      expect(sendArgs.replyTo).toContain("reply+");
      expect(sendArgs.headers["In-Reply-To"]).toBe(
        "<user-reply@mail.example.com>",
      );
      expect(sendArgs.headers["References"]).toBe(
        "<orig-user-msg@mail.example.com> <original-msg-id@vm7.bot> <user-reply@mail.example.com>",
      );

      // Verify thread session was updated with new messageId
      const updatedSession = await findTestEmailThreadSession(replyToken);
      expect(updatedSession).not.toBeNull();
      expect(updatedSession!.lastEmailMessageId).toBe(
        "<mock-message-id@vm7.bot>",
      );
    });

    it("should fall back to session.lastEmailMessageId when inbound headers are missing", async () => {
      const user = await context.setupUser({ prefix: "reply-fallback" });
      mockClerk({ userId: user.userId });
      const { composeId, agentId } = await createTestCompose(
        uniqueId("reply-agent"),
      );
      const agentSession = await createTestAgentSession(user.userId, composeId);
      const replyToken = generateReplyToken(agentSession.id);
      const emailSession = await createTestEmailThreadSession({
        userId: user.userId,
        agentId,
        agentSessionId: agentSession.id,
        replyToToken: replyToken,
        lastEmailMessageId: "<bot-prev@vm7.bot>",
      });

      const { runId } = await createTestRun(composeId, "Email reply task");
      await completeTestRun(user.userId, runId);

      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
        { eventData: { result: "Fallback output" } },
      ]);

      // Payload without inbound threading headers (backwards compatibility)
      const payload: ReplyCallbackPayload = {
        emailThreadSessionId: emailSession.id,
        inboundEmailId: "inbound-email-fallback",
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/zero/email/callbacks/reply",
        payload: { ...payload },
      });

      const request = createSignedCallbackRequest(
        "http://localhost/api/zero/email/callbacks/reply",
        { runId, status: "completed", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);

      expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
      const sendArgs = mockResend.emails.send.mock.calls[0]![0] as {
        headers: Record<string, string>;
      };
      // Falls back to session.lastEmailMessageId for both headers
      expect(sendArgs.headers["In-Reply-To"]).toBe("<bot-prev@vm7.bot>");
      expect(sendArgs.headers["References"]).toBe("<bot-prev@vm7.bot>");
    });

    it("should use session.lastEmailMessageId in References when inboundMessageId is present but inboundReferences is missing", async () => {
      const user = await context.setupUser({ prefix: "reply-partial" });
      mockClerk({ userId: user.userId });
      const { composeId, agentId } = await createTestCompose(
        uniqueId("reply-agent"),
      );
      const agentSession = await createTestAgentSession(user.userId, composeId);
      const replyToken = generateReplyToken(agentSession.id);
      const emailSession = await createTestEmailThreadSession({
        userId: user.userId,
        agentId,
        agentSessionId: agentSession.id,
        replyToToken: replyToken,
        lastEmailMessageId: "<bot-prev@vm7.bot>",
      });

      const { runId } = await createTestRun(composeId, "Email reply task");
      await completeTestRun(user.userId, runId);

      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
        { eventData: { result: "Partial headers output" } },
      ]);

      // Payload with inboundMessageId but no inboundReferences
      const payload: ReplyCallbackPayload = {
        emailThreadSessionId: emailSession.id,
        inboundEmailId: "inbound-email-partial",
        inboundMessageId: "<user-reply@mail.example.com>",
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/zero/email/callbacks/reply",
        payload: { ...payload },
      });

      const request = createSignedCallbackRequest(
        "http://localhost/api/zero/email/callbacks/reply",
        { runId, status: "completed", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);

      expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
      const sendArgs = mockResend.emails.send.mock.calls[0]![0] as {
        headers: Record<string, string>;
      };
      // In-Reply-To uses inbound Message-ID
      expect(sendArgs.headers["In-Reply-To"]).toBe(
        "<user-reply@mail.example.com>",
      );
      // References falls back to session.lastEmailMessageId + inbound Message-ID
      expect(sendArgs.headers["References"]).toBe(
        "<bot-prev@vm7.bot> <user-reply@mail.example.com>",
      );
    });

    it("should omit threading headers when both inbound and session message IDs are absent", async () => {
      const user = await context.setupUser({ prefix: "reply-no-ids" });
      mockClerk({ userId: user.userId });
      const { composeId, agentId } = await createTestCompose(
        uniqueId("reply-agent"),
      );
      const agentSession = await createTestAgentSession(user.userId, composeId);
      const replyToken = generateReplyToken(agentSession.id);
      const emailSession = await createTestEmailThreadSession({
        userId: user.userId,
        agentId,
        agentSessionId: agentSession.id,
        replyToToken: replyToken,
      });

      const { runId } = await createTestRun(composeId, "Email reply task");
      await completeTestRun(user.userId, runId);

      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
        { eventData: { result: "No threading output" } },
      ]);

      // Payload without any threading info, session also has no lastEmailMessageId
      const payload: ReplyCallbackPayload = {
        emailThreadSessionId: emailSession.id,
        inboundEmailId: "inbound-email-no-ids",
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/zero/email/callbacks/reply",
        payload: { ...payload },
      });

      const request = createSignedCallbackRequest(
        "http://localhost/api/zero/email/callbacks/reply",
        { runId, status: "completed", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);

      expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
      const sendArgs = mockResend.emails.send.mock.calls[0]![0] as {
        headers: Record<string, string>;
      };
      // No threading headers should be set
      expect(sendArgs.headers["In-Reply-To"]).toBeUndefined();
      expect(sendArgs.headers["References"]).toBeUndefined();
    });

    it("should send to multiple recipients when replyRecipientTo is provided", async () => {
      const user = await context.setupUser({ prefix: "reply-replyall" });
      mockClerk({ userId: user.userId });
      const { composeId, agentId } = await createTestCompose(
        uniqueId("reply-agent"),
      );
      const agentSession = await createTestAgentSession(user.userId, composeId);
      const replyToken = generateReplyToken(agentSession.id);
      const emailSession = await createTestEmailThreadSession({
        userId: user.userId,
        agentId,
        agentSessionId: agentSession.id,
        replyToToken: replyToken,
      });

      const { runId } = await createTestRun(composeId, "Email reply task");
      await completeTestRun(user.userId, runId);

      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
        { eventData: { result: "Reply-all output" } },
      ]);

      const payload: ReplyCallbackPayload = {
        emailThreadSessionId: emailSession.id,
        inboundEmailId: "inbound-email-replyall",
        replyRecipientTo: ["user-a@example.com", "user-b@example.com"],
        replyRecipientCc: ["user-c@example.com"],
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/zero/email/callbacks/reply",
        payload: { ...payload },
      });

      const request = createSignedCallbackRequest(
        "http://localhost/api/zero/email/callbacks/reply",
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

    it("should send error reply email on failed run", async () => {
      const user = await context.setupUser({ prefix: "reply-fail" });
      mockClerk({ userId: user.userId });
      const { composeId, agentId } = await createTestCompose(
        uniqueId("reply-agent"),
      );
      const agentSession = await createTestAgentSession(user.userId, composeId);
      const replyToken = generateReplyToken(agentSession.id);
      const emailSession = await createTestEmailThreadSession({
        userId: user.userId,
        agentId,
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
        url: "http://localhost/api/zero/email/callbacks/reply",
        payload: { ...payload },
      });

      const request = createSignedCallbackRequest(
        "http://localhost/api/zero/email/callbacks/reply",
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
