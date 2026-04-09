import { describe, it, expect, beforeEach, vi } from "vitest";
import { HttpResponse } from "msw";
import { Resend } from "resend";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestAgentSession,
  createTestSessionWithConversation,
  createTestEmailThreadSession,
  findTestRunsByUserAndPrompt,
  findTestRunsByUserAndPromptContaining,
  findTestCallbacksByRunId,
  insertOrgDefaultModelProvider,
  updateOrgDefaultAgent,
  generateTestReplyToken,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { server } from "../../../../../../src/mocks/server";
import { http } from "../../../../../../src/__tests__/msw";

const context = testContext();
const mockResend = vi.mocked(new Resend(""), true);

/** Mock factory: override receiving.get response for a single test */
function mockReceivedEmailGet(data: {
  from: string;
  to: string[];
  cc?: string[] | null;
  reply_to?: string[] | null;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  attachments?: Array<{
    id: string;
    filename: string;
    size: number;
    content_type: string;
    content_disposition: string;
  }>;
}) {
  // Resend SDK types are not exported; cast once here instead of in every test
  mockResend.emails.receiving.get.mockResolvedValueOnce({ data } as never);
}

/** Mock factory: override receiving.attachments.list response for a single test */
function mockReceivedEmailAttachmentsList(
  attachments: Array<{
    id: string;
    filename: string;
    size: number;
    content_type: string;
    content_disposition: string;
    download_url: string;
  }>,
) {
  mockResend.emails.receiving.attachments.list.mockResolvedValueOnce({
    data: { object: "list", has_more: false, data: attachments },
  } as never);
}

/** Build a valid Svix-signed webhook request */
function createWebhookRequest(body: string, headers?: Record<string, string>) {
  return createTestRequest("http://localhost:3000/api/zero/email/inbound", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "svix-id": "test-id",
      "svix-timestamp": String(Math.floor(Date.now() / 1000)),
      "svix-signature": "v1,test-signature",
      ...headers,
    },
    body,
  });
}

/** Extract the first emails.send call args (error reply email) */
function getErrorReplyArgs() {
  const call = mockResend.emails.send.mock.calls[0];
  return call?.[0] as
    | { from: string; to: string; subject: string; react: unknown }
    | undefined;
}

describe("POST /api/zero/email/inbound", () => {
  beforeEach(() => {
    context.setupMocks();
    mockClerk({ userId: null });
    mockResend.emails.send.mockClear();
  });

  it("should return 401 when Svix headers are missing", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/email/inbound",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "email.received", data: {} }),
      },
    );

    const response = await POST(request);

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe("Missing signature headers");
  });

  it("should return 401 when signature verification fails", async () => {
    // Send non-JSON body — the Svix mock does JSON.parse(payload) which will throw
    const request = createWebhookRequest("not-valid-json");

    const response = await POST(request);

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe("Invalid signature");
  });

  it("should acknowledge non-inbound event types", async () => {
    const payload = JSON.stringify({
      type: "email.sent",
      data: { email_id: "test-id" },
    });
    const request = createWebhookRequest(payload);

    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.received).toBe(true);
  });

  it("should process inbound email reply and dispatch agent run", async () => {
    // Given a user with a compose and email thread session
    const user = await context.setupUser();
    await insertOrgDefaultModelProvider(user.orgId, "anthropic-api-key");
    const { composeId, agentId } = await createTestCompose(
      uniqueId("email-agent"),
    );
    const agentSession = await createTestSessionWithConversation(
      user.userId,
      composeId,
    );

    // Generate a valid HMAC reply token
    const replyToken = generateTestReplyToken(agentSession.id);

    // Create email thread session that links the token to the compose/session
    await createTestEmailThreadSession({
      userId: user.userId,
      agentId,
      agentSessionId: agentSession.id,
      replyToToken: replyToken,
    });

    // Mock Clerk to return the session owner when looking up by email
    const senderEmail = "user@example.com";
    mockClerk({ userId: user.userId, email: senderEmail });

    // Build inbound email webhook payload
    const payload = JSON.stringify({
      type: "email.received",
      data: {
        email_id: "inbound-email-123",
        to: [`reply+${replyToken}@vm7.bot`],
        from: senderEmail,
        subject: "Re: test",
        created_at: new Date().toISOString(),
      },
    });

    const request = createWebhookRequest(payload);
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });

    // Flush the after() callback that handles the inbound reply
    await context.mocks.flushAfter();

    // Verify: agent run was created with the email body as prompt
    const runs = await findTestRunsByUserAndPromptContaining(
      user.userId,
      "Hello from email",
    );

    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.status).toBeDefined();

    // Verify: email reply callback was registered (instead of emailReplyRequest)
    const callbacks = await findTestCallbacksByRunId(run.id);
    expect(callbacks.length).toBeGreaterThanOrEqual(1);

    const emailReplyCallback = callbacks.find((c) => {
      return c.url.includes("/email/callbacks/reply");
    });
    expect(emailReplyCallback).toBeDefined();
    expect(emailReplyCallback!.payload).toEqual({
      emailThreadSessionId: expect.any(String),
      inboundEmailId: "inbound-email-123",
      inboundMessageId: "<default-msg-id@example.com>",
      replyRecipientTo: expect.any(Array),
      replyRecipientCc: expect.any(Array),
    });
  });

  it("should send error reply for emails with invalid HMAC reply token", async () => {
    mockResend.emails.receiving.get.mockClear();

    // Send an inbound email with a reply+ address but a tampered HMAC
    const senderEmail = "user@example.com";
    const payload = JSON.stringify({
      type: "email.received",
      data: {
        email_id: "tampered-email",
        to: ["reply+fake-session-id.badhmac0@vm7.bot"],
        from: senderEmail,
        subject: "Re: test",
        created_at: new Date().toISOString(),
      },
    });

    const request = createWebhookRequest(payload);
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });

    await context.mocks.flushAfter();

    // Handler should have returned early after HMAC verification failed
    expect(mockResend.emails.receiving.get).not.toHaveBeenCalled();

    // Error reply should have been sent
    expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
    const args = getErrorReplyArgs();
    expect(args?.to).toBe(senderEmail);
    expect(args?.subject).toBe("Re: test");
  });

  it("should send error reply for emails with empty content after quote stripping", async () => {
    // Given a user with a compose and email thread session
    const user = await context.setupUser({ prefix: "empty-reply" });
    const { composeId, agentId } = await createTestCompose(
      uniqueId("empty-agent"),
    );
    const agentSession = await createTestAgentSession(user.userId, composeId);
    const replyToken = generateTestReplyToken(agentSession.id);

    await createTestEmailThreadSession({
      userId: user.userId,
      agentId,
      agentSessionId: agentSession.id,
      replyToToken: replyToken,
    });

    // Mock Clerk to return the session owner when looking up by email
    const senderEmail = "user@example.com";
    mockClerk({ userId: user.userId, email: senderEmail });

    // Mock Resend to return empty text (e.g., email with only quoted content)
    mockReceivedEmailGet({
      from: senderEmail,
      to: [`reply+${replyToken}@vm7.bot`],
      subject: "Re: test",
      text: "   ",
      html: "<p></p>",
      headers: {
        "authentication-results":
          "mx.resend.com; dkim=pass; spf=pass; dmarc=pass",
      },
    });

    const payload = JSON.stringify({
      type: "email.received",
      data: {
        email_id: "empty-reply-email",
        to: [`reply+${replyToken}@vm7.bot`],
        from: senderEmail,
        subject: "Re: test",
        created_at: new Date().toISOString(),
      },
    });

    const request = createWebhookRequest(payload);
    const response = await POST(request);

    expect(response.status).toBe(200);
    await context.mocks.flushAfter();

    // No run should have been created
    const runs = await findTestRunsByUserAndPrompt(user.userId, "   ");
    expect(runs).toHaveLength(0);

    // Error reply should have been sent
    expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
    expect(getErrorReplyArgs()?.to).toBe(senderEmail);
  });

  // Note: "compose deleted" (inbound-reply.ts line 121-128) is unreachable in practice.
  // email_thread_sessions.agent_id has onDelete: cascade, so deleting a compose
  // also deletes all its thread sessions. The handler hits "session not found" first.

  it("should send error reply for emails without reply+ address", async () => {
    mockResend.emails.receiving.get.mockClear();

    const senderEmail = "user@example.com";

    // Send an inbound email that doesn't contain a reply+ address
    const payload = JSON.stringify({
      type: "email.received",
      data: {
        email_id: "no-reply-email",
        to: ["someone@example.com"],
        from: senderEmail,
        subject: "Hello",
        created_at: new Date().toISOString(),
      },
    });

    const request = createWebhookRequest(payload);
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });

    // Flush the after() callback
    await context.mocks.flushAfter();

    // The handler should have returned early — Resend receiving.get not called
    expect(mockResend.emails.receiving.get).not.toHaveBeenCalled();

    // Error reply should have been sent
    expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
    expect(getErrorReplyArgs()?.to).toBe(senderEmail);
  });

  it("should send error reply when reply sender is not a registered user", async () => {
    mockResend.emails.receiving.get.mockClear();

    // Given a user with a compose and email thread session
    const user = await context.setupUser({ prefix: "reply-unreg" });
    const { composeId, agentId } = await createTestCompose(
      uniqueId("reply-unreg-agent"),
    );
    const agentSession = await createTestSessionWithConversation(
      user.userId,
      composeId,
    );

    const replyToken = generateTestReplyToken(agentSession.id);
    await createTestEmailThreadSession({
      userId: user.userId,
      agentId,
      agentSessionId: agentSession.id,
      replyToToken: replyToken,
    });

    // Mock Clerk to return the session owner only for their email
    mockClerk({ userId: user.userId, email: "owner@example.com" });

    // Send reply from an unregistered email address
    const unregisteredSender = "stranger@example.com";
    const payload = JSON.stringify({
      type: "email.received",
      data: {
        email_id: "unreg-reply-email",
        to: [`reply+${replyToken}@vm7.bot`],
        from: unregisteredSender,
        subject: "Re: test",
        created_at: new Date().toISOString(),
      },
    });

    const request = createWebhookRequest(payload);
    const response = await POST(request);

    expect(response.status).toBe(200);
    await context.mocks.flushAfter();

    // No email should have been fetched (early return before Resend call)
    expect(mockResend.emails.receiving.get).not.toHaveBeenCalled();

    // Error reply should have been sent
    expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
    const args = getErrorReplyArgs();
    expect(args?.to).toBe(unregisteredSender);
    expect(args?.subject).toBe("Re: test");
    expect(JSON.stringify(args?.react)).toContain(
      "not associated with a VM0 account",
    );
  });

  it("should send error reply when reply sender is a different user than session owner", async () => {
    mockResend.emails.receiving.get.mockClear();

    // Given user A owns the session
    const userA = await context.setupUser({ prefix: "reply-owner" });
    const { composeId, agentId } = await createTestCompose(
      uniqueId("reply-diff-agent"),
    );
    const agentSession = await createTestSessionWithConversation(
      userA.userId,
      composeId,
    );

    const replyToken = generateTestReplyToken(agentSession.id);
    await createTestEmailThreadSession({
      userId: userA.userId,
      agentId,
      agentSessionId: agentSession.id,
      replyToToken: replyToken,
    });

    // Mock Clerk to return a DIFFERENT user (user B) when looking up by email
    const userBEmail = "user-b@example.com";
    mockClerk({ userId: "different-user-id", email: userBEmail });

    // User B replies to the thread (they were CC'd on the original email)
    const payload = JSON.stringify({
      type: "email.received",
      data: {
        email_id: "diff-user-reply-email",
        to: [`reply+${replyToken}@vm7.bot`],
        from: userBEmail,
        subject: "Re: test",
        created_at: new Date().toISOString(),
      },
    });

    const request = createWebhookRequest(payload);
    const response = await POST(request);

    expect(response.status).toBe(200);
    await context.mocks.flushAfter();

    // No email should have been fetched (early return before Resend call)
    expect(mockResend.emails.receiving.get).not.toHaveBeenCalled();

    // Error reply should have been sent
    expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
    const args = getErrorReplyArgs();
    expect(args?.to).toBe(userBEmail);
    expect(args?.subject).toBe("Re: test");
    expect(JSON.stringify(args?.react)).toContain(
      "Only the original sender can continue",
    );
  });

  it("should send error reply when reply email fails DMARC verification", async () => {
    // Given a user with a compose and email thread session
    const user = await context.setupUser({ prefix: "reply-dmarc" });
    const { composeId, agentId } = await createTestCompose(
      uniqueId("reply-dmarc-agent"),
    );
    const agentSession = await createTestSessionWithConversation(
      user.userId,
      composeId,
    );

    const replyToken = generateTestReplyToken(agentSession.id);
    await createTestEmailThreadSession({
      userId: user.userId,
      agentId,
      agentSessionId: agentSession.id,
      replyToToken: replyToken,
    });

    // Mock Clerk to return the session owner
    const senderEmail = "owner@example.com";
    mockClerk({ userId: user.userId, email: senderEmail });

    // Override Resend mock to return dmarc=fail
    mockReceivedEmailGet({
      from: senderEmail,
      to: [`reply+${replyToken}@vm7.bot`],
      subject: "Re: test",
      text: "Reply with failed DMARC",
      html: "<p>Reply with failed DMARC</p>",
      headers: {
        "Message-ID": "<dmarc-fail-reply@example.com>",
        "Authentication-Results":
          "mx.google.com; dkim=pass; spf=pass; dmarc=fail",
      },
    });

    const payload = JSON.stringify({
      type: "email.received",
      data: {
        email_id: "dmarc-fail-reply-email",
        to: [`reply+${replyToken}@vm7.bot`],
        from: senderEmail,
        subject: "Re: test",
        created_at: new Date().toISOString(),
      },
    });

    const request = createWebhookRequest(payload);
    const response = await POST(request);

    expect(response.status).toBe(200);
    await context.mocks.flushAfter();

    // No run should have been created
    const runs = await findTestRunsByUserAndPrompt(
      user.userId,
      "Reply with failed DMARC",
    );
    expect(runs).toHaveLength(0);

    // Error reply should have been sent
    expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
    const args = getErrorReplyArgs();
    expect(args?.to).toBe(senderEmail);
    expect(args?.subject).toBe("Re: test");
    expect(JSON.stringify(args?.react)).toContain("DMARC verification failed");
  });

  describe("Email Trigger (org@domain)", () => {
    it("should dispatch agent run for valid trigger email", async () => {
      // Given a user with an org and compose
      const user = await context.setupUser({ prefix: "trigger-user" });

      const suffix = user.userId.slice("trigger-user-".length);
      const orgSlug = `org-${suffix}`;
      const agentName = uniqueId("trigger-agent");

      // Create compose and set it as the org's default agent
      const { agentId } = await createTestCompose(agentName);
      await updateOrgDefaultAgent(user.orgId, agentId);

      // Mock Clerk to return the user when looking up by email
      const senderEmail = "sender@example.com";
      mockClerk({ userId: user.userId, email: senderEmail });

      // Build inbound email webhook payload with org@domain format
      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "trigger-email-123",
          to: [`${orgSlug}@vm7.bot`],
          from: senderEmail,
          subject: "Test Subject",
          created_at: new Date().toISOString(),
        },
      });

      const request = createWebhookRequest(payload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: true });

      // Flush the after() callback
      await context.mocks.flushAfter();

      // Verify: agent run was created with subject + body as prompt
      const runs = await findTestRunsByUserAndPromptContaining(
        user.userId,
        "Test Subject\n\nHello from email",
      );

      expect(runs).toHaveLength(1);
      const run = runs[0]!;
      expect(run.status).toBeDefined();

      // Verify: trigger callback was registered
      const callbacks = await findTestCallbacksByRunId(run.id);
      expect(callbacks.length).toBeGreaterThanOrEqual(1);

      const triggerCallback = callbacks.find((c) => {
        return c.url.includes("/email/callbacks/trigger");
      });
      expect(triggerCallback).toBeDefined();
      expect(triggerCallback!.payload).toMatchObject({
        senderEmail,
        agentId,
        userId: user.userId,
        inboundEmailId: "trigger-email-123",
        replyToken: expect.any(String),
        inboundMessageId: "<default-msg-id@example.com>",
        subject: "Test Subject",
      });
    });

    it("should send error reply for trigger email from unregistered sender", async () => {
      mockResend.emails.receiving.get.mockClear();

      // Mock Clerk to return user only for registered email
      mockClerk({ userId: "some-user-id", email: "registered@example.com" });

      // Send email from unregistered address to org@domain
      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "unreg-email",
          to: ["someorg@vm7.bot"],
          from: "unregistered@example.com",
          subject: "Test",
          created_at: new Date().toISOString(),
        },
      });

      const request = createWebhookRequest(payload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      // No email should have been fetched (early return)
      expect(mockResend.emails.receiving.get).not.toHaveBeenCalled();

      // Error reply should have been sent
      expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
      const args = getErrorReplyArgs();
      expect(args?.to).toBe("unregistered@example.com");
      expect(args?.subject).toBe("Re: Test");
    });

    it("should send error reply for trigger email to non-existent org", async () => {
      mockResend.emails.receiving.get.mockClear();

      const senderEmail = "sender@example.com";
      mockClerk({ userId: "some-user-id", email: senderEmail });

      // Send email to non-existent org
      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "no-org-email",
          to: ["nonexistent@vm7.bot"],
          from: senderEmail,
          subject: "Test",
          created_at: new Date().toISOString(),
        },
      });

      const request = createWebhookRequest(payload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      // Resend should not have been called (early return after agent lookup failed)
      expect(mockResend.emails.receiving.get).not.toHaveBeenCalled();

      // Error reply should have been sent
      expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
      const args = getErrorReplyArgs();
      expect(args?.to).toBe(senderEmail);
      expect(args?.subject).toBe("Re: Test");
    });

    it("should send error reply when sender is not a member of the org", async () => {
      mockResend.emails.receiving.get.mockClear();

      // Create a user with an org
      const ownerUser = await context.setupUser({ prefix: "perm-owner" });
      const suffix = ownerUser.userId.slice("perm-owner-".length);
      const orgSlug = `org-${suffix}`;

      // Mock Clerk to return a DIFFERENT user who is NOT a member of this org
      const senderEmail = "unauthorized@example.com";
      mockClerk({ userId: "unauthorized-user-id", email: senderEmail });

      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "no-perm-email",
          to: [`${orgSlug}@vm7.bot`],
          from: senderEmail,
          subject: "Forbidden",
          created_at: new Date().toISOString(),
        },
      });

      const request = createWebhookRequest(payload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      // No email should have been fetched (early return after membership check)
      expect(mockResend.emails.receiving.get).not.toHaveBeenCalled();

      // Error reply should have been sent
      expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
      const args = getErrorReplyArgs();
      expect(args?.to).toBe(senderEmail);
      expect(args?.subject).toBe("Re: Forbidden");
    });

    it("should send error reply when org has no default agent configured", async () => {
      mockResend.emails.receiving.get.mockClear();

      // Create a user with an org but do NOT set a default agent
      const user = await context.setupUser({ prefix: "no-default" });
      const suffix = user.userId.slice("no-default-".length);
      const orgSlug = `org-${suffix}`;

      const senderEmail = "sender@example.com";
      mockClerk({ userId: user.userId, email: senderEmail });

      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "no-default-email",
          to: [`${orgSlug}@vm7.bot`],
          from: senderEmail,
          subject: "No Agent",
          created_at: new Date().toISOString(),
        },
      });

      const request = createWebhookRequest(payload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      // No email should have been fetched (early return — no default agent)
      expect(mockResend.emails.receiving.get).not.toHaveBeenCalled();

      // Error reply should have been sent
      expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
      const args = getErrorReplyArgs();
      expect(args?.to).toBe(senderEmail);
      expect(args?.subject).toBe("Re: No Agent");
    });

    it("should send error reply when DMARC fails", async () => {
      const user = await context.setupUser({ prefix: "dmarc-fail" });
      const suffix = user.userId.slice("dmarc-fail-".length);
      const orgSlug = `org-${suffix}`;
      const agentName = uniqueId("dmarc-agent");
      const { agentId } = await createTestCompose(agentName);
      await updateOrgDefaultAgent(user.orgId, agentId);

      const senderEmail = "spoofed@example.com";
      mockClerk({ userId: user.userId, email: senderEmail });

      // Override Resend mock to return dmarc=fail
      mockReceivedEmailGet({
        from: senderEmail,
        to: [`${orgSlug}@vm7.bot`],
        subject: "Spoofed email",
        text: "I am pretending to be someone else",
        html: "<p>I am pretending to be someone else</p>",
        headers: {
          "authentication-results":
            "mx.resend.com; dkim=fail header.d=example.com; spf=fail smtp.mailfrom=attacker.com; dmarc=fail header.from=example.com",
        },
      });

      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "dmarc-fail-email",
          to: [`${orgSlug}@vm7.bot`],
          from: senderEmail,
          subject: "Spoofed email",
          created_at: new Date().toISOString(),
        },
      });

      const request = createWebhookRequest(payload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      // No run should have been created
      const runs = await findTestRunsByUserAndPrompt(
        user.userId,
        "Spoofed email\n\nI am pretending to be someone else",
      );
      expect(runs).toHaveLength(0);

      // Error reply should have been sent
      expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
      const args = getErrorReplyArgs();
      expect(args?.to).toBe(senderEmail);
      expect(args?.subject).toBe("Re: Spoofed email");
    });

    it("should send error reply when DMARC is none even if DKIM passes", async () => {
      const user = await context.setupUser({ prefix: "dkim-pass" });
      const suffix = user.userId.slice("dkim-pass-".length);
      const orgSlug = `org-${suffix}`;
      const agentName = uniqueId("dkim-agent");
      const { agentId } = await createTestCompose(agentName);
      await updateOrgDefaultAgent(user.orgId, agentId);

      const senderEmail = "user@nodmarc.com";
      mockClerk({ userId: user.userId, email: senderEmail });

      // Override Resend mock: dmarc=none but dkim=pass — still rejected
      mockReceivedEmailGet({
        from: senderEmail,
        to: [`${orgSlug}@vm7.bot`],
        subject: "DKIM Only",
        text: "My domain has no DMARC but DKIM is valid",
        html: "<p>My domain has no DMARC but DKIM is valid</p>",
        headers: {
          "authentication-results":
            "mx.resend.com; dkim=pass header.d=nodmarc.com; spf=fail smtp.mailfrom=nodmarc.com; dmarc=none header.from=nodmarc.com",
        },
      });

      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "dkim-pass-email",
          to: [`${orgSlug}@vm7.bot`],
          from: senderEmail,
          subject: "DKIM Only",
          created_at: new Date().toISOString(),
        },
      });

      const request = createWebhookRequest(payload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      // No run should have been created — DMARC-only policy rejects dmarc=none
      const runs = await findTestRunsByUserAndPrompt(
        user.userId,
        "DKIM Only\n\nMy domain has no DMARC but DKIM is valid",
      );
      expect(runs).toHaveLength(0);

      // Error reply should have been sent
      expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
      expect(getErrorReplyArgs()?.to).toBe(senderEmail);
    });

    it("should send error reply when authentication-results header is missing", async () => {
      const user = await context.setupUser({ prefix: "no-auth" });
      const suffix = user.userId.slice("no-auth-".length);
      const orgSlug = `org-${suffix}`;
      const agentName = uniqueId("noauth-agent");
      const { agentId } = await createTestCompose(agentName);
      await updateOrgDefaultAgent(user.orgId, agentId);

      const senderEmail = "user@example.com";
      mockClerk({ userId: user.userId, email: senderEmail });

      // Override Resend mock: no authentication-results header
      mockReceivedEmailGet({
        from: senderEmail,
        to: [`${orgSlug}@vm7.bot`],
        subject: "No Auth Headers",
        text: "Email without authentication results",
        html: "<p>Email without authentication results</p>",
        headers: {},
      });

      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "no-auth-email",
          to: [`${orgSlug}@vm7.bot`],
          from: senderEmail,
          subject: "No Auth Headers",
          created_at: new Date().toISOString(),
        },
      });

      const request = createWebhookRequest(payload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      // No run should have been created
      const runs = await findTestRunsByUserAndPrompt(
        user.userId,
        "No Auth Headers\n\nEmail without authentication results",
      );
      expect(runs).toHaveLength(0);

      // Error reply should have been sent
      expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
      expect(getErrorReplyArgs()?.to).toBe(senderEmail);
    });

    it("should send error reply when all authentication methods fail", async () => {
      const user = await context.setupUser({ prefix: "all-fail" });
      const suffix = user.userId.slice("all-fail-".length);
      const orgSlug = `org-${suffix}`;
      const agentName = uniqueId("allfail-agent");
      const { agentId } = await createTestCompose(agentName);
      await updateOrgDefaultAgent(user.orgId, agentId);

      const senderEmail = "user@misconfigured.com";
      mockClerk({ userId: user.userId, email: senderEmail });

      // Override Resend mock: all authentication methods fail
      mockReceivedEmailGet({
        from: senderEmail,
        to: [`${orgSlug}@vm7.bot`],
        subject: "All Fail",
        text: "Everything failed",
        html: "<p>Everything failed</p>",
        headers: {
          "authentication-results":
            "mx.resend.com; dkim=fail; spf=fail; dmarc=fail",
        },
      });

      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "all-fail-email",
          to: [`${orgSlug}@vm7.bot`],
          from: senderEmail,
          subject: "All Fail",
          created_at: new Date().toISOString(),
        },
      });

      const request = createWebhookRequest(payload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      // No run should have been created
      const runs = await findTestRunsByUserAndPrompt(
        user.userId,
        "All Fail\n\nEverything failed",
      );
      expect(runs).toHaveLength(0);

      // Error reply should have been sent
      expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
      expect(getErrorReplyArgs()?.to).toBe(senderEmail);
    });

    it("should send error reply when email body is empty", async () => {
      const user = await context.setupUser({ prefix: "empty-trigger" });
      const suffix = user.userId.slice("empty-trigger-".length);
      const orgSlug = `org-${suffix}`;
      const agentName = uniqueId("empty-body-agent");
      const { agentId } = await createTestCompose(agentName);
      await updateOrgDefaultAgent(user.orgId, agentId);

      const senderEmail = "sender@example.com";
      mockClerk({ userId: user.userId, email: senderEmail });

      // Return an email with empty text and empty HTML, DMARC passes
      mockReceivedEmailGet({
        from: senderEmail,
        to: [`${orgSlug}@vm7.bot`],
        subject: "",
        text: "",
        html: "",
        headers: {
          "authentication-results":
            "mx.resend.com; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com",
        },
      });

      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "empty-body-email",
          to: [`${orgSlug}@vm7.bot`],
          from: senderEmail,
          subject: "",
          created_at: new Date().toISOString(),
        },
      });

      const request = createWebhookRequest(payload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      // Error reply should have been sent
      expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
      const args = getErrorReplyArgs();
      expect(args?.to).toBe(senderEmail);
      expect(args?.subject).toBe("Email delivery failed");
    });

    it("should extract content from HTML when text is empty", async () => {
      const user = await context.setupUser({ prefix: "html-trigger" });
      const suffix = user.userId.slice("html-trigger-".length);
      const orgSlug = `org-${suffix}`;
      const agentName = uniqueId("html-agent");
      const { agentId } = await createTestCompose(agentName);
      await updateOrgDefaultAgent(user.orgId, agentId);

      const senderEmail = "sender@example.com";
      mockClerk({ userId: user.userId, email: senderEmail });

      // Override Resend mock to return HTML-only content (empty text)
      mockReceivedEmailGet({
        from: senderEmail,
        to: [`${orgSlug}@vm7.bot`],
        subject: "Newsletter",
        text: "",
        html: "<p>Rich content from newsletter</p>",
        headers: {
          "authentication-results":
            "mx.resend.com; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com",
        },
      });

      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "html-only-trigger",
          to: [`${orgSlug}@vm7.bot`],
          from: senderEmail,
          subject: "Newsletter",
          created_at: new Date().toISOString(),
        },
      });

      const request = createWebhookRequest(payload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      // Verify agent run was created with HTML-derived content
      // Prompt = subject + "\n\n" + converted HTML body
      const runs = await findTestRunsByUserAndPromptContaining(
        user.userId,
        "Newsletter\n\nRich content from newsletter",
      );
      expect(runs).toHaveLength(1);
    });
  });

  it("should extract content from HTML when text is empty (reply)", async () => {
    const user = await context.setupUser({ prefix: "html-reply" });
    await insertOrgDefaultModelProvider(user.orgId, "anthropic-api-key");
    const { composeId, agentId } = await createTestCompose(
      uniqueId("html-reply-agent"),
    );
    const agentSession = await createTestSessionWithConversation(
      user.userId,
      composeId,
    );
    const replyToken = generateTestReplyToken(agentSession.id);

    await createTestEmailThreadSession({
      userId: user.userId,
      agentId,
      agentSessionId: agentSession.id,
      replyToToken: replyToken,
    });

    // Mock Clerk to return the session owner when looking up by email
    const senderEmail = "user@example.com";
    mockClerk({ userId: user.userId, email: senderEmail });

    // Override Resend mock to return HTML-only content
    mockReceivedEmailGet({
      from: senderEmail,
      to: [`reply+${replyToken}@vm7.bot`],
      subject: "Re: test",
      text: "",
      html: "<p>This is my HTML reply</p>",
      headers: {
        "authentication-results":
          "mx.resend.com; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com",
      },
    });

    const payload = JSON.stringify({
      type: "email.received",
      data: {
        email_id: "html-only-reply",
        to: [`reply+${replyToken}@vm7.bot`],
        from: senderEmail,
        subject: "Re: test",
        created_at: new Date().toISOString(),
      },
    });

    const request = createWebhookRequest(payload);
    const response = await POST(request);

    expect(response.status).toBe(200);
    await context.mocks.flushAfter();

    // Verify agent run was created with HTML-derived content
    const runs = await findTestRunsByUserAndPromptContaining(
      user.userId,
      "This is my HTML reply",
    );
    expect(runs).toHaveLength(1);
  });

  describe("Email Trigger with Attachments", () => {
    it("should include attachment URLs in prompt when email has attachments", async () => {
      const user = await context.setupUser({ prefix: "att-trigger" });
      const suffix = user.userId.slice("att-trigger-".length);
      const orgSlug = `org-${suffix}`;
      const agentName = uniqueId("att-agent");
      const { agentId } = await createTestCompose(agentName);
      await updateOrgDefaultAgent(user.orgId, agentId);

      const senderEmail = "sender@example.com";
      mockClerk({ userId: user.userId, email: senderEmail });

      // Mock Resend to return email with attachment metadata
      mockReceivedEmailGet({
        from: senderEmail,
        to: [`${orgSlug}@vm7.bot`],
        subject: "With Attachment",
        text: "Please review the attached file",
        html: "<p>Please review the attached file</p>",
        headers: {
          "authentication-results":
            "mx.resend.com; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com",
          "message-id": "<att-msg-id@example.com>",
        },
        attachments: [
          {
            id: "att-1",
            filename: "invoice.pdf",
            size: 5000,
            content_type: "application/pdf",
            content_disposition: "attachment",
          },
        ],
      });

      // Mock attachment list API
      mockReceivedEmailAttachmentsList([
        {
          id: "att-1",
          filename: "invoice.pdf",
          size: 5000,
          content_type: "application/pdf",
          content_disposition: "attachment",
          download_url: "https://download.resend.com/att-trigger-1",
        },
      ]);

      // Mock attachment download via MSW
      const pdfBuffer = Buffer.from("fake-pdf-content");
      const downloadHandler = http.get(
        "https://download.resend.com/att-trigger-1",
        () => {
          return new HttpResponse(pdfBuffer, {
            headers: { "content-type": "application/pdf" },
          });
        },
      );
      server.use(downloadHandler.handler);

      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "trigger-att-email",
          to: [`${orgSlug}@vm7.bot`],
          from: senderEmail,
          subject: "With Attachment",
          created_at: new Date().toISOString(),
        },
      });

      const request = createWebhookRequest(payload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      // Verify: agent run was created with body + attachment info in prompt
      const matchingRuns = await findTestRunsByUserAndPromptContaining(
        user.userId,
        "With Attachment",
      );
      expect(matchingRuns).toHaveLength(1);
      expect(matchingRuns[0]!.prompt).toContain(
        "Please review the attached file",
      );
      expect(matchingRuns[0]!.prompt).toContain("[attachment]: invoice.pdf");
      expect(matchingRuns[0]!.prompt).toContain("https://mock-presigned-url");

      // Verify: S3 upload was called for the attachment
      expect(context.mocks.s3.uploadS3Buffer).toHaveBeenCalledWith(
        "test-bucket",
        "email-attachments/trigger-att-email/att-1-invoice.pdf",
        expect.any(Buffer),
        "application/pdf",
      );
    });

    it("should skip oversized attachment with 'exceeds size limit' message", async () => {
      const user = await context.setupUser({ prefix: "att-oversize" });
      const suffix = user.userId.slice("att-oversize-".length);
      const orgSlug = `org-${suffix}`;
      const agentName = uniqueId("oversize-agent");
      const { agentId: oversizeAgentId } = await createTestCompose(agentName);
      await updateOrgDefaultAgent(user.orgId, oversizeAgentId);

      const senderEmail = "sender@example.com";
      mockClerk({ userId: user.userId, email: senderEmail });

      mockReceivedEmailGet({
        from: senderEmail,
        to: [`${orgSlug}@vm7.bot`],
        subject: "Big File",
        text: "See attached",
        html: "<p>See attached</p>",
        headers: {
          "authentication-results":
            "mx.resend.com; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com",
        },
      });

      // Return an attachment that exceeds 10MB size limit
      mockReceivedEmailAttachmentsList([
        {
          id: "att-big",
          filename: "huge.zip",
          size: 15 * 1024 * 1024,
          content_type: "application/zip",
          content_disposition: "attachment",
          download_url: "https://download.resend.com/att-big",
        },
      ]);

      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "oversize-email",
          to: [`${orgSlug}@vm7.bot`],
          from: senderEmail,
          subject: "Big File",
          created_at: new Date().toISOString(),
        },
      });

      const request = createWebhookRequest(payload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const runs = await findTestRunsByUserAndPromptContaining(
        user.userId,
        "Big File",
      );
      expect(runs).toHaveLength(1);
      expect(runs[0]!.prompt).toContain("huge.zip");
      expect(runs[0]!.prompt).toContain("skipped: exceeds size limit");
      expect(context.mocks.s3.uploadS3Buffer).not.toHaveBeenCalled();
    });

    it("should skip attachment with 'download failed' when download returns error", async () => {
      const user = await context.setupUser({ prefix: "att-dl-fail" });
      const suffix = user.userId.slice("att-dl-fail-".length);
      const orgSlug = `org-${suffix}`;
      const agentName = uniqueId("dlfail-agent");
      const { agentId: dlfailAgentId } = await createTestCompose(agentName);
      await updateOrgDefaultAgent(user.orgId, dlfailAgentId);

      const senderEmail = "sender@example.com";
      mockClerk({ userId: user.userId, email: senderEmail });

      mockReceivedEmailGet({
        from: senderEmail,
        to: [`${orgSlug}@vm7.bot`],
        subject: "Broken Attachment",
        text: "File attached",
        html: "<p>File attached</p>",
        headers: {
          "authentication-results":
            "mx.resend.com; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com",
        },
      });

      mockReceivedEmailAttachmentsList([
        {
          id: "att-broken",
          filename: "broken.pdf",
          size: 5000,
          content_type: "application/pdf",
          content_disposition: "attachment",
          download_url: "https://download.resend.com/att-broken",
        },
      ]);

      // Return 500 for the download
      const downloadHandler = http.get(
        "https://download.resend.com/att-broken",
        () => {
          return new HttpResponse(null, { status: 500 });
        },
      );
      server.use(downloadHandler.handler);

      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "dl-fail-email",
          to: [`${orgSlug}@vm7.bot`],
          from: senderEmail,
          subject: "Broken Attachment",
          created_at: new Date().toISOString(),
        },
      });

      const request = createWebhookRequest(payload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const runs = await findTestRunsByUserAndPromptContaining(
        user.userId,
        "Broken Attachment",
      );
      expect(runs).toHaveLength(1);
      expect(runs[0]!.prompt).toContain("broken.pdf");
      expect(runs[0]!.prompt).toContain("skipped: download failed");
      expect(context.mocks.s3.uploadS3Buffer).not.toHaveBeenCalled();
    });

    it("should handle multiple attachments with mixed results", async () => {
      const user = await context.setupUser({ prefix: "att-mixed" });
      const suffix = user.userId.slice("att-mixed-".length);
      const orgSlug = `org-${suffix}`;
      const agentName = uniqueId("mixed-agent");
      const { agentId: mixedAgentId } = await createTestCompose(agentName);
      await updateOrgDefaultAgent(user.orgId, mixedAgentId);

      const senderEmail = "sender@example.com";
      mockClerk({ userId: user.userId, email: senderEmail });

      mockReceivedEmailGet({
        from: senderEmail,
        to: [`${orgSlug}@vm7.bot`],
        subject: "Multiple Files",
        text: "Several attachments",
        html: "<p>Several attachments</p>",
        headers: {
          "authentication-results":
            "mx.resend.com; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com",
        },
      });

      // Three attachments: one good, one oversized, one download fails
      mockReceivedEmailAttachmentsList([
        {
          id: "att-good",
          filename: "report.pdf",
          size: 5000,
          content_type: "application/pdf",
          content_disposition: "attachment",
          download_url: "https://download.resend.com/att-good",
        },
        {
          id: "att-huge",
          filename: "video.mp4",
          size: 15 * 1024 * 1024,
          content_type: "video/mp4",
          content_disposition: "attachment",
          download_url: "https://download.resend.com/att-huge",
        },
        {
          id: "att-err",
          filename: "missing.docx",
          size: 3000,
          content_type:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          content_disposition: "attachment",
          download_url: "https://download.resend.com/att-err",
        },
      ]);

      // Good attachment downloads successfully
      const goodHandler = http.get(
        "https://download.resend.com/att-good",
        () => {
          return new HttpResponse(Buffer.from("pdf-content"), {
            headers: { "content-type": "application/pdf" },
          });
        },
      );
      // Failed attachment returns 404
      const errHandler = http.get("https://download.resend.com/att-err", () => {
        return new HttpResponse(null, { status: 404 });
      });
      server.use(goodHandler.handler, errHandler.handler);

      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "mixed-att-email",
          to: [`${orgSlug}@vm7.bot`],
          from: senderEmail,
          subject: "Multiple Files",
          created_at: new Date().toISOString(),
        },
      });

      const request = createWebhookRequest(payload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const runs = await findTestRunsByUserAndPromptContaining(
        user.userId,
        "Multiple Files",
      );
      expect(runs).toHaveLength(1);
      const prompt = runs[0]!.prompt;

      // Good attachment: uploaded and URL in prompt
      expect(prompt).toContain("[attachment]: report.pdf");
      expect(prompt).toContain("https://mock-presigned-url");

      // Oversized attachment: skipped with reason
      expect(prompt).toContain("video.mp4");
      expect(prompt).toContain("skipped: exceeds size limit");

      // Failed download: skipped with reason
      expect(prompt).toContain("missing.docx");
      expect(prompt).toContain("skipped: download failed");

      // Only one upload (the good attachment)
      expect(context.mocks.s3.uploadS3Buffer).toHaveBeenCalledTimes(1);
    });

    it("should replace inline image data URI with placeholder in prompt", async () => {
      const user = await context.setupUser({ prefix: "inline-img" });
      const suffix = user.userId.slice("inline-img-".length);
      const orgSlug = `org-${suffix}`;
      const agentName = uniqueId("inline-agent");
      const { agentId: inlineAgentId } = await createTestCompose(agentName);
      await updateOrgDefaultAgent(user.orgId, inlineAgentId);

      const senderEmail = "sender@example.com";
      mockClerk({ userId: user.userId, email: senderEmail });

      // Simulate Gmail inline image: base64 data URI embedded in HTML body
      const fakeBase64 = "A".repeat(1000);
      mockReceivedEmailGet({
        from: senderEmail,
        to: [`${orgSlug}@vm7.bot`],
        subject: "Check this photo",
        text: "",
        html: `<p>Can you see what I'm doing?</p><img src="data:image/jpeg;base64,${fakeBase64}" alt="photo.jpg">`,
        headers: {
          "authentication-results":
            "mx.resend.com; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com",
        },
      });

      // Inline image also appears in attachments list (Resend returns it)
      mockReceivedEmailAttachmentsList([
        {
          id: "inline-att-1",
          filename: "photo.jpg",
          size: 750,
          content_type: "image/jpeg",
          content_disposition: "inline",
          download_url: "https://download.resend.com/inline-img-1",
        },
      ]);

      // Mock download for the inline image
      const imgBuffer = Buffer.from("fake-jpeg-bytes");
      const downloadHandler = http.get(
        "https://download.resend.com/inline-img-1",
        () => {
          return new HttpResponse(imgBuffer, {
            headers: { "content-type": "image/jpeg" },
          });
        },
      );
      server.use(downloadHandler.handler);

      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "inline-img-email",
          to: [`${orgSlug}@vm7.bot`],
          from: senderEmail,
          subject: "Check this photo",
          created_at: new Date().toISOString(),
        },
      });

      const request = createWebhookRequest(payload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const runs = await findTestRunsByUserAndPromptContaining(
        user.userId,
        "Check this photo",
      );
      expect(runs).toHaveLength(1);
      const prompt = runs[0]!.prompt;

      // Text body preserved
      expect(prompt).toContain("Can you see what I'm doing?");
      // Placeholder replaces data URI
      expect(prompt).toContain("[inline image: photo.jpg]");
      // Base64 data NOT in prompt
      expect(prompt).not.toContain("data:image/jpeg;base64");
      // Inline image processed through attachment pipeline
      expect(prompt).toContain("[attachment]: photo.jpg");
      expect(prompt).toContain("https://mock-presigned-url");
    });

    it("should handle inline image without alt text", async () => {
      const user = await context.setupUser({ prefix: "inline-noalt" });
      const suffix = user.userId.slice("inline-noalt-".length);
      const orgSlug = `org-${suffix}`;
      const agentName = uniqueId("noalt-agent");
      const { agentId: noaltAgentId } = await createTestCompose(agentName);
      await updateOrgDefaultAgent(user.orgId, noaltAgentId);

      const senderEmail = "sender@example.com";
      mockClerk({ userId: user.userId, email: senderEmail });

      // Inline image with no alt attribute
      const fakeBase64 = "B".repeat(500);
      mockReceivedEmailGet({
        from: senderEmail,
        to: [`${orgSlug}@vm7.bot`],
        subject: "No Alt Image",
        text: "",
        html: `<p>Look at this</p><img src="data:image/png;base64,${fakeBase64}">`,
        headers: {
          "authentication-results":
            "mx.resend.com; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com",
        },
      });

      mockReceivedEmailAttachmentsList([
        {
          id: "inline-noalt-1",
          filename: "image.png",
          size: 375,
          content_type: "image/png",
          content_disposition: "inline",
          download_url: "https://download.resend.com/inline-noalt-1",
        },
      ]);

      const downloadHandler = http.get(
        "https://download.resend.com/inline-noalt-1",
        () => {
          return new HttpResponse(Buffer.from("fake-png"), {
            headers: { "content-type": "image/png" },
          });
        },
      );
      server.use(downloadHandler.handler);

      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "noalt-img-email",
          to: [`${orgSlug}@vm7.bot`],
          from: senderEmail,
          subject: "No Alt Image",
          created_at: new Date().toISOString(),
        },
      });

      const request = createWebhookRequest(payload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const runs = await findTestRunsByUserAndPromptContaining(
        user.userId,
        "No Alt Image",
      );
      expect(runs).toHaveLength(1);
      const prompt = runs[0]!.prompt;

      // Generic placeholder (no alt text available)
      expect(prompt).toContain("[inline image]");
      // Base64 data NOT in prompt
      expect(prompt).not.toContain("data:image/png;base64");
    });
  });

  describe("Email Reply with Attachments", () => {
    it("should include attachment URLs in prompt when reply has attachments", async () => {
      const user = await context.setupUser({ prefix: "att-reply" });
      await insertOrgDefaultModelProvider(user.orgId, "anthropic-api-key");
      const { composeId, agentId } = await createTestCompose(
        uniqueId("att-reply-agent"),
      );
      const agentSession = await createTestSessionWithConversation(
        user.userId,
        composeId,
      );
      const replyToken = generateTestReplyToken(agentSession.id);

      await createTestEmailThreadSession({
        userId: user.userId,
        agentId,
        agentSessionId: agentSession.id,
        replyToToken: replyToken,
      });

      // Mock Clerk to return the session owner when looking up by email
      const senderEmail = "user@example.com";
      mockClerk({ userId: user.userId, email: senderEmail });

      // Mock Resend to return reply email
      mockReceivedEmailGet({
        from: senderEmail,
        to: [`reply+${replyToken}@vm7.bot`],
        subject: "Re: test",
        text: "Here is the file you requested",
        html: "<p>Here is the file you requested</p>",
        headers: {
          "authentication-results":
            "mx.resend.com; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com",
        },
        attachments: [
          {
            id: "att-r1",
            filename: "data.csv",
            size: 200,
            content_type: "text/csv",
            content_disposition: "attachment",
          },
        ],
      });

      // Mock attachment list API
      mockReceivedEmailAttachmentsList([
        {
          id: "att-r1",
          filename: "data.csv",
          size: 200,
          content_type: "text/csv",
          content_disposition: "attachment",
          download_url: "https://download.resend.com/att-reply-1",
        },
      ]);

      // Mock attachment download via MSW
      const csvBuffer = Buffer.from("col1,col2\nval1,val2");
      const downloadHandler = http.get(
        "https://download.resend.com/att-reply-1",
        () => {
          return new HttpResponse(csvBuffer, {
            headers: { "content-type": "text/csv" },
          });
        },
      );
      server.use(downloadHandler.handler);

      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "reply-att-email",
          to: [`reply+${replyToken}@vm7.bot`],
          from: senderEmail,
          subject: "Re: test",
          created_at: new Date().toISOString(),
        },
      });

      const request = createWebhookRequest(payload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      // Verify: agent run was created with body + attachment info in prompt
      const matchingReplyRuns = await findTestRunsByUserAndPromptContaining(
        user.userId,
        "Here is the file you requested",
      );
      expect(matchingReplyRuns).toHaveLength(1);
      expect(matchingReplyRuns[0]!.prompt).toContain("[attachment]: data.csv");
      expect(matchingReplyRuns[0]!.prompt).toContain(
        "https://mock-presigned-url",
      );
    });
  });

  describe("Email Trigger — old format rejection", () => {
    it("should send error reply for old org+agent format", async () => {
      mockResend.emails.receiving.get.mockClear();

      const senderEmail = "sender@example.com";
      mockClerk({ userId: "some-user-id", email: senderEmail });

      // Old format: org+agent@domain — rejected by parseOrgEmailAddress
      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "old-format-email",
          to: ["someorg+someagent@vm7.bot"],
          from: senderEmail,
          subject: "Old Format",
          created_at: new Date().toISOString(),
        },
      });

      const request = createWebhookRequest(payload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      expect(mockResend.emails.receiving.get).not.toHaveBeenCalled();
      expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
      expect(getErrorReplyArgs()?.to).toBe(senderEmail);
    });

    it("should send error reply for old org/agent format", async () => {
      mockResend.emails.receiving.get.mockClear();

      const senderEmail = "sender@example.com";
      mockClerk({ userId: "some-user-id", email: senderEmail });

      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "old-slash-email",
          to: ["someorg/someagent@vm7.bot"],
          from: senderEmail,
          subject: "Old Slash Format",
          created_at: new Date().toISOString(),
        },
      });

      const request = createWebhookRequest(payload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      expect(mockResend.emails.receiving.get).not.toHaveBeenCalled();
      expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
      expect(getErrorReplyArgs()?.to).toBe(senderEmail);
    });
  });

  it("should send error reply when trigger address is not recognized", async () => {
    mockResend.emails.receiving.get.mockClear();

    // Send to an address with a + prefix that doesn't match org+agent format
    // and parseAgentOnlyAddress returns null because it contains a "+"
    const senderEmail = "user@example.com";
    const payload = JSON.stringify({
      type: "email.received",
      data: {
        email_id: "bad-addr-email",
        to: ["+invalid@vm7.bot"],
        from: senderEmail,
        subject: "Bad Address",
        created_at: new Date().toISOString(),
      },
    });

    const request = createWebhookRequest(payload);
    const response = await POST(request);

    expect(response.status).toBe(200);
    await context.mocks.flushAfter();

    // No email should have been fetched
    expect(mockResend.emails.receiving.get).not.toHaveBeenCalled();

    // Error reply should have been sent
    expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
    const args = getErrorReplyArgs();
    expect(args?.to).toBe(senderEmail);
    expect(args?.subject).toBe("Re: Bad Address");
  });

  it("should send error reply when handler throws unexpected exception", async () => {
    // Set up a valid trigger scenario so the handler proceeds past address parsing
    const user = await context.setupUser({ prefix: "crash-user" });
    const suffix = user.userId.slice("crash-user-".length);
    const orgSlug = `org-${suffix}`;
    const agentName = uniqueId("crash-agent");
    const { agentId: crashAgentId } = await createTestCompose(agentName);
    await updateOrgDefaultAgent(user.orgId, crashAgentId);

    // Mock Clerk to return the user when looking up by email
    const senderEmail = "crash-sender@example.com";
    mockClerk({ userId: user.userId, email: senderEmail });

    // Make getReceivedEmail throw an unexpected error
    mockResend.emails.receiving.get.mockRejectedValueOnce(
      new Error("Resend API unavailable"),
    );

    const payload = JSON.stringify({
      type: "email.received",
      data: {
        email_id: "crash-email-123",
        to: [`${orgSlug}@vm7.bot`],
        from: senderEmail,
        subject: "Test crash",
        created_at: new Date().toISOString(),
      },
    });

    const request = createWebhookRequest(payload);
    const response = await POST(request);

    expect(response.status).toBe(200);
    await context.mocks.flushAfter();

    // The route catch block should have sent an error reply
    expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
    const args = getErrorReplyArgs();
    expect(args?.to).toBe(senderEmail);
    expect(args?.subject).toBe("Re: Test crash");
  });
});
