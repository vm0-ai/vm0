import { describe, it, expect, beforeEach, vi } from "vitest";
import { Resend } from "resend";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestAgentSession,
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
    const agentSession = await createTestAgentSession(user.userId, composeId);

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
});
