import { describe, it, expect, beforeEach, vi } from "vitest";
import { Resend } from "resend";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestAgentSession,
  createTestSessionWithConversation,
  createTestEmailThreadSession,
  findTestRunsByUserAndPrompt,
  findTestCallbacksByRunId,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { generateReplyToken } from "../../../../../../src/lib/email/handlers/shared";

const context = testContext();
const mockResend = vi.mocked(new Resend(""), true);

/** Build a valid Svix-signed webhook request */
function createWebhookRequest(body: string, headers?: Record<string, string>) {
  return createTestRequest("http://localhost:3000/api/webhooks/email/inbound", {
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

describe("POST /api/webhooks/email/inbound", () => {
  beforeEach(() => {
    context.setupMocks();
    mockClerk({ userId: null });
  });

  it("should return 401 when Svix headers are missing", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/webhooks/email/inbound",
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
    const { composeId } = await createTestCompose(uniqueId("email-agent"));
    const agentSession = await createTestSessionWithConversation(
      user.userId,
      composeId,
    );

    // Generate a valid HMAC reply token
    const replyToken = generateReplyToken(agentSession.id);

    // Create email thread session that links the token to the compose/session
    await createTestEmailThreadSession({
      userId: user.userId,
      composeId,
      agentSessionId: agentSession.id,
      replyToToken: replyToken,
    });

    // Switch to webhook auth (no Clerk)
    mockClerk({ userId: null });

    // Build inbound email webhook payload
    const payload = JSON.stringify({
      type: "email.received",
      data: {
        email_id: "inbound-email-123",
        to: [`reply+${replyToken}@vm7.bot`],
        from: "user@example.com",
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
    const runs = await findTestRunsByUserAndPrompt(
      user.userId,
      "Hello from email",
    );

    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.status).toBeDefined();

    // Verify: email reply callback was registered (instead of emailReplyRequest)
    const callbacks = await findTestCallbacksByRunId(run.id);
    expect(callbacks.length).toBeGreaterThanOrEqual(1);

    const emailReplyCallback = callbacks.find((c) =>
      c.url.includes("/callbacks/email/reply"),
    );
    expect(emailReplyCallback).toBeDefined();
    expect(emailReplyCallback!.payload).toEqual({
      emailThreadSessionId: expect.any(String),
      inboundEmailId: "inbound-email-123",
    });
  });

  it("should ignore emails with invalid HMAC reply token", async () => {
    mockResend.emails.receiving.get.mockClear();

    // Send an inbound email with a reply+ address but a tampered HMAC
    const payload = JSON.stringify({
      type: "email.received",
      data: {
        email_id: "tampered-email",
        to: ["reply+fake-session-id.badhmac0@vm7.bot"],
        from: "user@example.com",
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
  });

  it("should ignore emails with empty content after quote stripping", async () => {
    // Given a user with a compose and email thread session
    const user = await context.setupUser({ prefix: "empty-reply" });
    const { composeId } = await createTestCompose(uniqueId("empty-agent"));
    const agentSession = await createTestAgentSession(user.userId, composeId);
    const replyToken = generateReplyToken(agentSession.id);

    await createTestEmailThreadSession({
      userId: user.userId,
      composeId,
      agentSessionId: agentSession.id,
      replyToToken: replyToken,
    });

    mockClerk({ userId: null });

    // Mock Resend to return empty text (e.g., email with only quoted content)
    mockResend.emails.receiving.get.mockResolvedValueOnce({
      data: {
        from: "user@example.com",
        to: [`reply+${replyToken}@vm7.bot`],
        subject: "Re: test",
        text: "   ",
        html: "<p></p>",
      },
    } as never);

    const payload = JSON.stringify({
      type: "email.received",
      data: {
        email_id: "empty-reply-email",
        to: [`reply+${replyToken}@vm7.bot`],
        from: "user@example.com",
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
  });

  it("should ignore emails without reply+ address", async () => {
    mockResend.emails.receiving.get.mockClear();

    // Send an inbound email that doesn't contain a reply+ address
    const payload = JSON.stringify({
      type: "email.received",
      data: {
        email_id: "no-reply-email",
        to: ["someone@example.com"],
        from: "user@example.com",
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
  });

  describe("Email Trigger (scope+agent@domain)", () => {
    it("should dispatch agent run for valid trigger email", async () => {
      // Given a user with a scope and compose
      // setupUser creates a user with userId = "trigger-user-{suffix}" and
      // scope slug = "scope-{suffix}" using the same suffix
      const user = await context.setupUser({ prefix: "trigger-user" });

      // Extract suffix from userId to derive scope slug
      // userId format: "{prefix}-{suffix}" where suffix is an 8-char UUID
      const suffix = user.userId.slice("trigger-user-".length);
      const scopeSlug = `scope-${suffix}`;
      const agentName = uniqueId("trigger-agent");

      // Create compose (automatically associates with user's scope)
      const { composeId } = await createTestCompose(agentName);

      // Mock Clerk to return the user when looking up by email
      const senderEmail = "sender@example.com";
      mockClerk({ userId: user.userId, email: senderEmail });

      // Build inbound email webhook payload with scope+agent format
      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "trigger-email-123",
          to: [`${scopeSlug}+${agentName}@vm7.bot`],
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
      const runs = await findTestRunsByUserAndPrompt(
        user.userId,
        "Test Subject\n\nHello from email",
      );

      expect(runs).toHaveLength(1);
      const run = runs[0]!;
      expect(run.status).toBeDefined();

      // Verify: trigger callback was registered
      const callbacks = await findTestCallbacksByRunId(run.id);
      expect(callbacks.length).toBeGreaterThanOrEqual(1);

      const triggerCallback = callbacks.find((c) =>
        c.url.includes("/callbacks/email/trigger"),
      );
      expect(triggerCallback).toBeDefined();
      expect(triggerCallback!.payload).toMatchObject({
        senderEmail,
        composeId,
        userId: user.userId,
        inboundEmailId: "trigger-email-123",
        replyToken: expect.any(String),
      });
    });

    it("should ignore trigger email from unregistered sender", async () => {
      mockResend.emails.receiving.get.mockClear();

      // Mock Clerk to return user only for registered email
      mockClerk({ userId: "some-user-id", email: "registered@example.com" });

      // Send email from unregistered address
      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "unreg-email",
          to: ["somescope+someagent@vm7.bot"],
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
    });

    it("should ignore trigger email for non-existent agent", async () => {
      mockResend.emails.receiving.get.mockClear();

      const senderEmail = "sender@example.com";
      mockClerk({ userId: "some-user-id", email: senderEmail });

      // Send email to non-existent scope/agent
      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "no-agent-email",
          to: ["nonexistent+fakeagent@vm7.bot"],
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
    });

    it("should reject trigger email when DMARC fails", async () => {
      const user = await context.setupUser({ prefix: "dmarc-fail" });
      const suffix = user.userId.slice("dmarc-fail-".length);
      const scopeSlug = `scope-${suffix}`;
      const agentName = uniqueId("dmarc-agent");
      await createTestCompose(agentName);

      const senderEmail = "spoofed@example.com";
      mockClerk({ userId: user.userId, email: senderEmail });

      // Override Resend mock to return dmarc=fail
      mockResend.emails.receiving.get.mockResolvedValueOnce({
        data: {
          from: senderEmail,
          to: [`${scopeSlug}+${agentName}@vm7.bot`],
          subject: "Spoofed email",
          text: "I am pretending to be someone else",
          html: "<p>I am pretending to be someone else</p>",
          headers: {
            "authentication-results":
              "mx.resend.com; dkim=fail header.d=example.com; spf=fail smtp.mailfrom=attacker.com; dmarc=fail header.from=example.com",
          },
        },
      } as never);

      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "dmarc-fail-email",
          to: [`${scopeSlug}+${agentName}@vm7.bot`],
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
    });

    it("should reject trigger email when DMARC is none even if DKIM passes", async () => {
      const user = await context.setupUser({ prefix: "dkim-pass" });
      const suffix = user.userId.slice("dkim-pass-".length);
      const scopeSlug = `scope-${suffix}`;
      const agentName = uniqueId("dkim-agent");
      await createTestCompose(agentName);

      const senderEmail = "user@nodmarc.com";
      mockClerk({ userId: user.userId, email: senderEmail });

      // Override Resend mock: dmarc=none but dkim=pass — still rejected
      mockResend.emails.receiving.get.mockResolvedValueOnce({
        data: {
          from: senderEmail,
          to: [`${scopeSlug}+${agentName}@vm7.bot`],
          subject: "DKIM Only",
          text: "My domain has no DMARC but DKIM is valid",
          html: "<p>My domain has no DMARC but DKIM is valid</p>",
          headers: {
            "authentication-results":
              "mx.resend.com; dkim=pass header.d=nodmarc.com; spf=fail smtp.mailfrom=nodmarc.com; dmarc=none header.from=nodmarc.com",
          },
        },
      } as never);

      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "dkim-pass-email",
          to: [`${scopeSlug}+${agentName}@vm7.bot`],
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
    });

    it("should reject trigger email when authentication-results header is missing", async () => {
      const user = await context.setupUser({ prefix: "no-auth" });
      const suffix = user.userId.slice("no-auth-".length);
      const scopeSlug = `scope-${suffix}`;
      const agentName = uniqueId("noauth-agent");
      await createTestCompose(agentName);

      const senderEmail = "user@example.com";
      mockClerk({ userId: user.userId, email: senderEmail });

      // Override Resend mock: no authentication-results header
      mockResend.emails.receiving.get.mockResolvedValueOnce({
        data: {
          from: senderEmail,
          to: [`${scopeSlug}+${agentName}@vm7.bot`],
          subject: "No Auth Headers",
          text: "Email without authentication results",
          html: "<p>Email without authentication results</p>",
          headers: {},
        },
      } as never);

      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "no-auth-email",
          to: [`${scopeSlug}+${agentName}@vm7.bot`],
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
    });

    it("should reject trigger email when all authentication methods fail", async () => {
      const user = await context.setupUser({ prefix: "all-fail" });
      const suffix = user.userId.slice("all-fail-".length);
      const scopeSlug = `scope-${suffix}`;
      const agentName = uniqueId("allfail-agent");
      await createTestCompose(agentName);

      const senderEmail = "user@misconfigured.com";
      mockClerk({ userId: user.userId, email: senderEmail });

      // Override Resend mock: all authentication methods fail
      mockResend.emails.receiving.get.mockResolvedValueOnce({
        data: {
          from: senderEmail,
          to: [`${scopeSlug}+${agentName}@vm7.bot`],
          subject: "All Fail",
          text: "Everything failed",
          html: "<p>Everything failed</p>",
          headers: {
            "authentication-results":
              "mx.resend.com; dkim=fail; spf=fail; dmarc=fail",
          },
        },
      } as never);

      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "all-fail-email",
          to: [`${scopeSlug}+${agentName}@vm7.bot`],
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
    });

    it("should extract content from HTML when text is empty", async () => {
      const user = await context.setupUser({ prefix: "html-trigger" });
      const suffix = user.userId.slice("html-trigger-".length);
      const scopeSlug = `scope-${suffix}`;
      const agentName = uniqueId("html-agent");
      await createTestCompose(agentName);

      const senderEmail = "sender@example.com";
      mockClerk({ userId: user.userId, email: senderEmail });

      // Override Resend mock to return HTML-only content (empty text)
      mockResend.emails.receiving.get.mockResolvedValueOnce({
        data: {
          from: senderEmail,
          to: [`${scopeSlug}+${agentName}@vm7.bot`],
          subject: "Newsletter",
          text: "",
          html: "<p>Rich content from newsletter</p>",
          headers: {
            "authentication-results":
              "mx.resend.com; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com",
          },
        },
      } as never);

      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "html-only-trigger",
          to: [`${scopeSlug}+${agentName}@vm7.bot`],
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
      const runs = await findTestRunsByUserAndPrompt(
        user.userId,
        "Newsletter\n\nRich content from newsletter",
      );
      expect(runs).toHaveLength(1);
    });
  });

  it("should extract content from HTML when text is empty (reply)", async () => {
    const user = await context.setupUser({ prefix: "html-reply" });
    const { composeId } = await createTestCompose(uniqueId("html-reply-agent"));
    const agentSession = await createTestSessionWithConversation(
      user.userId,
      composeId,
    );
    const replyToken = generateReplyToken(agentSession.id);

    await createTestEmailThreadSession({
      userId: user.userId,
      composeId,
      agentSessionId: agentSession.id,
      replyToToken: replyToken,
    });

    mockClerk({ userId: null });

    // Override Resend mock to return HTML-only content
    mockResend.emails.receiving.get.mockResolvedValueOnce({
      data: {
        from: "user@example.com",
        to: [`reply+${replyToken}@vm7.bot`],
        subject: "Re: test",
        text: "",
        html: "<p>This is my HTML reply</p>",
        headers: {
          "authentication-results":
            "mx.resend.com; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com",
        },
      },
    } as never);

    const payload = JSON.stringify({
      type: "email.received",
      data: {
        email_id: "html-only-reply",
        to: [`reply+${replyToken}@vm7.bot`],
        from: "user@example.com",
        subject: "Re: test",
        created_at: new Date().toISOString(),
      },
    });

    const request = createWebhookRequest(payload);
    const response = await POST(request);

    expect(response.status).toBe(200);
    await context.mocks.flushAfter();

    // Verify agent run was created with HTML-derived content
    const runs = await findTestRunsByUserAndPrompt(
      user.userId,
      "This is my HTML reply",
    );
    expect(runs).toHaveLength(1);
  });

  describe("Email Trigger (agent@domain, auto-detect scope)", () => {
    it("should dispatch agent run for agent-only email (auto-detect scope)", async () => {
      const user = await context.setupUser({ prefix: "auto-scope" });
      const agentName = uniqueId("auto-agent");
      await createTestCompose(agentName);

      const senderEmail = "sender@example.com";
      mockClerk({ userId: user.userId, email: senderEmail });

      // Send to agentname@domain (no scope, no plus sign)
      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "auto-scope-email",
          to: [`${agentName}@vm7.bot`],
          from: senderEmail,
          subject: "Auto Scope Test",
          created_at: new Date().toISOString(),
        },
      });

      const request = createWebhookRequest(payload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      // Verify: agent run was created
      const runs = await findTestRunsByUserAndPrompt(
        user.userId,
        "Auto Scope Test\n\nHello from email",
      );
      expect(runs).toHaveLength(1);

      // Verify: trigger callback was registered
      const callbacks = await findTestCallbacksByRunId(runs[0]!.id);
      const triggerCallback = callbacks.find((c) =>
        c.url.includes("/callbacks/email/trigger"),
      );
      expect(triggerCallback).toBeDefined();
      expect(triggerCallback!.payload).toMatchObject({
        senderEmail,
        userId: user.userId,
        inboundEmailId: "auto-scope-email",
      });
    });

    it("should ignore agent-only email from unregistered sender", async () => {
      mockResend.emails.receiving.get.mockClear();
      mockClerk({ userId: "some-user-id", email: "registered@example.com" });

      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "unreg-auto-email",
          to: ["someagent@vm7.bot"],
          from: "unregistered@example.com",
          subject: "Test",
          created_at: new Date().toISOString(),
        },
      });

      const request = createWebhookRequest(payload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      expect(mockResend.emails.receiving.get).not.toHaveBeenCalled();
    });

    it("should ignore agent-only email when sender has no scope", async () => {
      mockResend.emails.receiving.get.mockClear();

      // Mock Clerk to return a userId that has no scope in the database
      const senderEmail = "noscopeuser@example.com";
      mockClerk({ userId: "no-scope-user-id", email: senderEmail });

      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "no-scope-email",
          to: ["someagent@vm7.bot"],
          from: senderEmail,
          subject: "Test",
          created_at: new Date().toISOString(),
        },
      });

      const request = createWebhookRequest(payload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      // No email fetch should have happened (early return after scope lookup failed)
      expect(mockResend.emails.receiving.get).not.toHaveBeenCalled();
    });

    it("should ignore agent-only email for non-existent agent", async () => {
      mockResend.emails.receiving.get.mockClear();

      const user = await context.setupUser({ prefix: "no-agent" });
      const senderEmail = "sender@example.com";
      mockClerk({ userId: user.userId, email: senderEmail });

      // Send to an agent that doesn't exist in the sender's scope
      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "no-agent-auto-email",
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

      expect(mockResend.emails.receiving.get).not.toHaveBeenCalled();
    });

    it("should reject agent-only email when DMARC fails", async () => {
      const user = await context.setupUser({ prefix: "auto-dmarc" });
      const agentName = uniqueId("auto-dmarc-agent");
      await createTestCompose(agentName);

      const senderEmail = "spoofed@example.com";
      mockClerk({ userId: user.userId, email: senderEmail });

      // Override Resend mock to return dmarc=fail
      mockResend.emails.receiving.get.mockResolvedValueOnce({
        data: {
          from: senderEmail,
          to: [`${agentName}@vm7.bot`],
          subject: "Spoofed auto-scope",
          text: "I am pretending to be someone else",
          html: "<p>I am pretending to be someone else</p>",
          headers: {
            "authentication-results":
              "mx.resend.com; dkim=fail; spf=fail; dmarc=fail",
          },
        },
      } as never);

      const payload = JSON.stringify({
        type: "email.received",
        data: {
          email_id: "auto-dmarc-fail-email",
          to: [`${agentName}@vm7.bot`],
          from: senderEmail,
          subject: "Spoofed auto-scope",
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
        "Spoofed auto-scope\n\nI am pretending to be someone else",
      );
      expect(runs).toHaveLength(0);
    });
  });
});
