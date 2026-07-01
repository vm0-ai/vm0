import { randomUUID } from "node:crypto";

import { Webhook } from "svix";
import { describe, expect, it, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import { createAppWithRoutes } from "../../../app-factory-core";
import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { now } from "../../external/time";
import { testEmailStateRoutes } from "../test-email-state";
import { zeroEmailCallbackRoutes } from "../zero-email-callbacks";
import { zeroEmailInboundRoutes } from "../zero-email-inbound";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/zero-feature-switches";

const context = testContext();
const resendMocks = context.mocks.resend;
const routeMocks = createZeroRouteMocks(context);

const CALLBACK_SECRET = "test-callback-secret";
const INBOUND_SECRET = "whsec_test";
const REPLY_PATH = "/api/zero/email/callbacks/reply";
const TRIGGER_PATH = "/api/zero/email/callbacks/trigger";
const INBOUND_PATH = "/api/zero/email/inbound";
const EMAIL_STATE_PATH = "/api/test/email-state/action";
const emailRoutes = [
  ...zeroEmailCallbackRoutes,
  ...zeroEmailInboundRoutes,
  ...testEmailStateRoutes,
] as const;

interface EmailFixture {
  readonly orgId: string;
  readonly orgSlug: string;
  readonly userId: string;
  readonly userEmail: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly versionId: string;
}

interface EmailThreadState {
  readonly id: string;
  readonly replyToken: string;
  readonly agentSessionId?: string;
  readonly lastEmailMessageId?: string | null;
}

interface EmailRunState {
  readonly id: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly triggerSource?: string | null;
  readonly callbacks: readonly {
    readonly url: string | null;
    readonly payload: Record<string, unknown> | null;
  }[];
}

interface EmailOutboxState {
  readonly toAddresses: string | readonly string[];
  readonly subject: string;
  readonly template: Record<string, unknown>;
}

async function emailStateAction(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await requestEmailApp(EMAIL_STATE_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

function actionFixture(result: Record<string, unknown>): EmailFixture {
  const fixture = result.fixture;
  expect(fixture).toBeDefined();
  return fixture as EmailFixture;
}

function actionThread(result: Record<string, unknown>): EmailThreadState {
  const thread = result.thread;
  expect(thread).toBeDefined();
  return thread as EmailThreadState;
}

function actionRuns(result: Record<string, unknown>): readonly EmailRunState[] {
  expect(Array.isArray(result.runs)).toBeTruthy();
  return result.runs as readonly EmailRunState[];
}

const track = createFixtureTracker<EmailFixture>(async (fixture) => {
  await deleteFeatureSwitchesForUser(context, fixture);
  await emailStateAction({ action: "delete-fixture", fixture });
});

async function fixture(): Promise<EmailFixture> {
  const created = await track(
    emailStateAction({ action: "seed-fixture" }).then(actionFixture),
  );
  routeMocks.clerk.session(created.userId, created.orgId);
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [{ organization: { id: created.orgId }, role: "org:member" }],
  });
  context.mocks.s3.send.mockResolvedValue({});
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  return created;
}

async function seedAgentSession(fx: EmailFixture): Promise<string> {
  const result = await emailStateAction({
    action: "seed-agent-session",
    fixture: fx,
  });
  expect(typeof result.agentSessionId).toBe("string");
  return result.agentSessionId as string;
}

async function seedThread(args: {
  readonly fixture: EmailFixture;
  readonly agentSessionId: string;
  readonly lastEmailMessageId?: string | null;
}): Promise<EmailThreadState> {
  return actionThread(
    await emailStateAction({
      action: "seed-thread",
      fixture: args.fixture,
      agent_session_id: args.agentSessionId,
      last_email_message_id: args.lastEmailMessageId,
    }),
  );
}

interface CallbackPostOptions {
  readonly secret?: string;
  readonly timestamp?: number;
}

function signedCallbackHeaders(
  rawBody: string,
  options: CallbackPostOptions = {},
) {
  const timestamp = options.timestamp ?? Math.floor(now() / 1000);
  return {
    "Content-Type": "application/json",
    "X-VM0-Signature": computeHmacSignature(
      rawBody,
      options.secret ?? CALLBACK_SECRET,
      timestamp,
    ),
    "X-VM0-Timestamp": String(timestamp),
  };
}

async function postCallback(
  path: string,
  body: Record<string, unknown>,
  options?: CallbackPostOptions | string,
): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const headerOptions =
    typeof options === "string" ? { secret: options } : options;
  return await requestEmailApp(path, {
    method: "POST",
    headers: signedCallbackHeaders(rawBody, headerOptions),
    body: rawBody,
  });
}

async function requestEmailApp(
  path: string,
  init: RequestInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: emailRoutes,
  });
  return await app.request(path, init);
}

function svixHeaders(rawBody: string): Record<string, string> {
  const id = `msg_${randomUUID()}`;
  const timestamp = nowDate();
  return {
    "Content-Type": "application/json",
    "svix-id": id,
    "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "svix-signature": new Webhook(INBOUND_SECRET).sign(id, timestamp, rawBody),
  };
}

async function postInbound(event: WebhookEvent): Promise<Response> {
  const rawBody = JSON.stringify(event);
  return await requestEmailApp(INBOUND_PATH, {
    method: "POST",
    headers: svixHeaders(rawBody),
    body: rawBody,
  });
}

interface WebhookEvent {
  readonly type: string;
  readonly data?: {
    readonly email_id?: string;
    readonly to?: readonly string[];
    readonly from?: string;
    readonly subject?: string;
  };
}

function mockReceivedEmail(args: {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly replyTo?: readonly string[];
  readonly subject?: string;
  readonly text?: string;
  readonly html?: string;
  readonly headers?: Record<string, string>;
}): void {
  const headers =
    args.headers ??
    ({
      "Authentication-Results": "mx.example; dmarc=pass",
      "Message-ID": "<inbound@example.com>",
    } satisfies Record<string, string>);
  resendMocks.receivingGet.mockResolvedValue({
    data: {
      from: args.from,
      to: [...args.to],
      cc: [...(args.cc ?? [])],
      reply_to: [...(args.replyTo ?? [])],
      subject: args.subject ?? "Email subject",
      text: args.text ?? "Email body",
      html: args.html ?? "",
      headers,
    },
  });
}

function mockNoAttachments(): void {
  resendMocks.attachmentsList.mockResolvedValue({ data: { data: [] } });
}

interface MockEmailAttachment {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
  readonly contentType: string;
  readonly contentDisposition: string;
  readonly downloadUrl: string;
}

function mockEmailAttachments(
  attachments: readonly MockEmailAttachment[],
): void {
  resendMocks.attachmentsList.mockResolvedValue({
    data: {
      data: attachments.map((attachment) => {
        return {
          id: attachment.id,
          filename: attachment.filename,
          size: attachment.size,
          content_type: attachment.contentType,
          content_disposition: attachment.contentDisposition,
          download_url: attachment.downloadUrl,
        };
      }),
    },
  });
}

function mockAttachmentDownload(args: {
  readonly url: string;
  readonly body?: BodyInit | null;
  readonly status?: number;
  readonly contentType?: string;
}): void {
  server.use(
    http.get(args.url, () => {
      return new HttpResponse(args.body ?? Buffer.from("attachment bytes"), {
        status: args.status ?? 200,
        headers: { "content-type": args.contentType ?? "application/pdf" },
      });
    }),
  );
}

function mockRunOutput(text: string): void {
  context.mocks.axiom.query
    .mockResolvedValueOnce(
      Array.from({ length: 4 }, (_, sequenceNumber) => {
        return { sequenceNumber };
      }),
    )
    .mockResolvedValueOnce([
      { eventType: "result", eventData: { result: text } },
    ]);
}

interface SentEmail {
  readonly to?: string | readonly string[];
  readonly cc?: string | readonly string[];
  readonly subject?: string;
  readonly html?: string;
  readonly headers?: Record<string, string>;
  readonly replyTo?: string;
}

function lastSentEmail(): SentEmail {
  const call = resendMocks.send.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call![0] as SentEmail;
}

async function seedReplyCallback(args: {
  readonly fixture: EmailFixture;
  readonly status?: "completed" | "failed" | "running";
  readonly result?: Record<string, unknown> | null;
  readonly prompt?: string;
  readonly lastEmailMessageId?: string | null;
}): Promise<{
  readonly callbackId: string;
  readonly runId: string;
  readonly thread: EmailThreadState;
}> {
  const result = await emailStateAction({
    action: "seed-reply-callback",
    fixture: args.fixture,
    status: args.status ?? "completed",
    result: args.result,
    prompt: args.prompt,
    last_email_message_id: args.lastEmailMessageId,
  });
  expect(typeof result.callbackId).toBe("string");
  expect(typeof result.runId).toBe("string");
  return {
    callbackId: result.callbackId as string,
    runId: result.runId as string,
    thread: actionThread(result),
  };
}

async function seedTriggerCallback(args: {
  readonly fixture: EmailFixture;
  readonly status?: "completed" | "failed" | "running";
  readonly result?: Record<string, unknown> | null;
  readonly prompt?: string;
}): Promise<{
  readonly callbackId: string;
  readonly runId: string;
  readonly replyToken: string;
}> {
  const result = await emailStateAction({
    action: "seed-trigger-callback",
    fixture: args.fixture,
    status: args.status ?? "completed",
    result: args.result,
    prompt: args.prompt,
  });
  expect(typeof result.callbackId).toBe("string");
  expect(typeof result.runId).toBe("string");
  expect(typeof result.replyToken).toBe("string");
  return {
    callbackId: result.callbackId as string,
    runId: result.runId as string,
    replyToken: result.replyToken as string,
  };
}

beforeEach(() => {
  resendMocks.send.mockReset();
  resendMocks.get.mockReset();
  resendMocks.receivingGet.mockReset();
  resendMocks.attachmentsList.mockReset();
  resendMocks.send.mockResolvedValue({ data: { id: "resend-test-id" } });
  resendMocks.get.mockResolvedValue({
    data: { message_id: "<sent@example.com>" },
  });
  mockEnv("RESEND_API_KEY", "test-resend-key");
  mockEnv("RESEND_WEBHOOK_SECRET", INBOUND_SECRET);
  mockEnv("RESEND_FROM_DOMAIN", "mail.example.com");
});

describe("POST /api/zero/email/callbacks/reply", () => {
  it("rejects invalid callback signatures", async () => {
    const fx = await fixture();
    const { callbackId, runId, thread } = await seedReplyCallback({
      fixture: fx,
    });

    const response = await postCallback(
      REPLY_PATH,
      {
        callbackId,
        runId,
        status: "completed",
        payload: {
          emailThreadSessionId: thread.id,
          inboundEmailId: "email_inbound",
        },
      },
      "wrong-secret",
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Invalid signature",
    });
  });

  it("sends a reply email and updates thread state after completion", async () => {
    const fx = await fixture();
    const nextSessionId = await seedAgentSession(fx);
    const { callbackId, runId, thread } = await seedReplyCallback({
      fixture: fx,
      result: { agentSessionId: nextSessionId },
      prompt: "summarize email",
      lastEmailMessageId: "<previous@example.com>",
    });
    mockRunOutput("final email answer");

    const response = await postCallback(REPLY_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: {
        emailThreadSessionId: thread.id,
        inboundEmailId: "email_inbound",
        inboundMessageId: "<inbound@example.com>",
        inboundReferences: "<root@example.com>",
        replyRecipientTo: ["sender@example.com", "teammate@example.com"],
        replyRecipientCc: ["cc@example.com"],
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    expect(resendMocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: `Zero <${fx.orgSlug}@mail.example.com>`,
        to: ["sender@example.com", "teammate@example.com"],
        cc: ["cc@example.com"],
        replyTo: `reply+${thread.replyToken}@mail.example.com`,
        subject: `Re: VM0 - Automation run for "${fx.agentName}" completed`,
        headers: expect.objectContaining({
          "In-Reply-To": "<inbound@example.com>",
          References: "<root@example.com> <inbound@example.com>",
        }),
      }),
    );
    const email = lastSentEmail();
    expect(email.html).toContain("final email answer");
    expect(email.html).not.toContain(`/activities/${runId}`);

    const updatedThread = actionThread(
      await emailStateAction({ action: "get-thread", id: thread.id }),
    );
    expect(updatedThread).toMatchObject({
      agentSessionId: nextSessionId,
      lastEmailMessageId: "<sent@example.com>",
    });
  });

  it("includes the audit log link when the AuditLink switch is enabled", async () => {
    const fx = await fixture();
    const { callbackId, runId, thread } = await seedReplyCallback({
      fixture: fx,
    });
    await updateFeatureSwitchesForUser(context, fx, {
      [FeatureSwitchKey.ZeroDebug]: true,
    });
    mockRunOutput("audited email answer");

    const response = await postCallback(REPLY_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: {
        emailThreadSessionId: thread.id,
        inboundEmailId: "email_audit",
      },
    });

    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.html).toContain(`/activities/${runId}`);
  });

  it("falls back to the last sent email message id when inbound threading headers are missing", async () => {
    const fx = await fixture();
    const { callbackId, runId, thread } = await seedReplyCallback({
      fixture: fx,
      lastEmailMessageId: "<bot-prev@example.com>",
    });
    mockRunOutput("fallback threading answer");

    const response = await postCallback(REPLY_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: {
        emailThreadSessionId: thread.id,
        inboundEmailId: "email_fallback",
      },
    });

    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.headers?.["In-Reply-To"]).toBe("<bot-prev@example.com>");
    expect(email.headers?.References).toBe("<bot-prev@example.com>");
  });

  it("uses the last sent message id in references when only the inbound message id is present", async () => {
    const fx = await fixture();
    const { callbackId, runId, thread } = await seedReplyCallback({
      fixture: fx,
      lastEmailMessageId: "<bot-prev@example.com>",
    });
    mockRunOutput("partial threading answer");

    const response = await postCallback(REPLY_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: {
        emailThreadSessionId: thread.id,
        inboundEmailId: "email_partial",
        inboundMessageId: "<inbound@example.com>",
      },
    });

    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.headers?.["In-Reply-To"]).toBe("<inbound@example.com>");
    expect(email.headers?.References).toBe(
      "<bot-prev@example.com> <inbound@example.com>",
    );
  });

  it("omits threading headers when neither inbound nor session message ids exist", async () => {
    const fx = await fixture();
    const { callbackId, runId, thread } = await seedReplyCallback({
      fixture: fx,
    });
    mockRunOutput("no threading answer");

    const response = await postCallback(REPLY_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: {
        emailThreadSessionId: thread.id,
        inboundEmailId: "email_without_threading",
      },
    });

    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.headers?.["In-Reply-To"]).toBeUndefined();
    expect(email.headers?.References).toBeUndefined();
  });

  it("falls back to the thread owner email and sends the failure message on failed runs", async () => {
    const fx = await fixture();
    const { callbackId, runId, thread } = await seedReplyCallback({
      fixture: fx,
      status: "failed",
    });

    const response = await postCallback(REPLY_PATH, {
      callbackId,
      runId,
      status: "failed",
      error: "Agent crashed",
      payload: {
        emailThreadSessionId: thread.id,
        inboundEmailId: "email_failed",
      },
    });

    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.to).toBe(fx.userEmail);
    expect(email.subject).toBe(
      `Re: VM0 - Automation run for "${fx.agentName}" completed`,
    );
    expect(email.html).toContain("Agent crashed");
  });
});

describe("POST /api/zero/email/callbacks/trigger", () => {
  it("skips before callback verification when Resend is not configured", async () => {
    mockEnv("RESEND_API_KEY", undefined);

    const response = await requestEmailApp(TRIGGER_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: randomUUID(), status: "completed" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      success: true,
      skipped: true,
    });
  });

  it("rejects invalid callback signatures", async () => {
    const fx = await fixture();
    const { callbackId, runId, replyToken } = await seedTriggerCallback({
      fixture: fx,
    });

    const response = await postCallback(
      TRIGGER_PATH,
      {
        callbackId,
        runId,
        status: "completed",
        payload: {
          senderEmail: fx.userEmail,
          agentId: fx.agentId,
          userId: fx.userId,
          inboundEmailId: "email_invalid_signature",
          replyToken,
        },
      },
      "wrong-secret",
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Invalid signature",
    });
  });

  it("rejects expired callback timestamps", async () => {
    const fx = await fixture();
    const { callbackId, runId, replyToken } = await seedTriggerCallback({
      fixture: fx,
    });

    const response = await postCallback(
      TRIGGER_PATH,
      {
        callbackId,
        runId,
        status: "completed",
        payload: {
          senderEmail: fx.userEmail,
          agentId: fx.agentId,
          userId: fx.userId,
          inboundEmailId: "email_expired_signature",
          replyToken,
        },
      },
      { timestamp: Math.floor(now() / 1000) - 1000 },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Timestamp expired",
    });
  });

  it("sends a response email and creates the thread session", async () => {
    const fx = await fixture();
    const agentSessionId = await seedAgentSession(fx);
    const { callbackId, runId, replyToken } = await seedTriggerCallback({
      fixture: fx,
      result: { agentSessionId },
      prompt: "trigger prompt",
    });
    mockRunOutput("trigger response");

    const response = await postCallback(TRIGGER_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: {
        senderEmail: fx.userEmail,
        agentId: fx.agentId,
        userId: fx.userId,
        inboundEmailId: "email_inbound",
        replyToken,
        inboundMessageId: "<inbound@example.com>",
        inboundReferences: "<root@example.com>",
        subject: "Need help",
        runtimeOrgId: fx.orgId,
        replyRecipientTo: ["sender@example.com"],
        replyRecipientCc: ["cc@example.com"],
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    expect(resendMocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: `Zero <${fx.orgSlug}@mail.example.com>`,
        to: ["sender@example.com"],
        cc: ["cc@example.com"],
        replyTo: `reply+${replyToken}@mail.example.com`,
        subject: "Re: Need help",
        headers: expect.objectContaining({
          "In-Reply-To": "<inbound@example.com>",
          References: "<root@example.com> <inbound@example.com>",
        }),
      }),
    );
    const email = lastSentEmail();
    expect(email.html).toContain("trigger response");
    expect(email.html).not.toContain(`/activities/${runId}`);

    const thread = actionThread(
      await emailStateAction({
        action: "get-thread",
        reply_token: replyToken,
      }),
    );
    expect(thread).toMatchObject({
      userId: fx.userId,
      agentId: fx.agentId,
      agentSessionId,
      lastEmailMessageId: "<sent@example.com>",
      orgId: fx.orgId,
    });
  });

  it("includes the audit log link when the AuditLink switch is enabled", async () => {
    const fx = await fixture();
    const agentSessionId = await seedAgentSession(fx);
    const { callbackId, runId, replyToken } = await seedTriggerCallback({
      fixture: fx,
      result: { agentSessionId },
    });
    await updateFeatureSwitchesForUser(context, fx, {
      [FeatureSwitchKey.ZeroDebug]: true,
    });
    mockRunOutput("audited trigger response");

    const response = await postCallback(TRIGGER_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: {
        senderEmail: fx.userEmail,
        agentId: fx.agentId,
        userId: fx.userId,
        inboundEmailId: "email_trigger_audit",
        replyToken,
        runtimeOrgId: fx.orgId,
      },
    });

    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.html).toContain(`/activities/${runId}`);
  });

  it("strips an existing Re prefix from the trigger subject", async () => {
    const fx = await fixture();
    const agentSessionId = await seedAgentSession(fx);
    const { callbackId, runId, replyToken } = await seedTriggerCallback({
      fixture: fx,
      result: { agentSessionId },
    });
    mockRunOutput("subject normalized response");

    const response = await postCallback(TRIGGER_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: {
        senderEmail: fx.userEmail,
        agentId: fx.agentId,
        userId: fx.userId,
        inboundEmailId: "email_subject_re",
        replyToken,
        subject: "Re: Original Topic",
        runtimeOrgId: fx.orgId,
      },
    });

    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.subject).toBe("Re: Original Topic");
  });

  it("falls back to senderEmail when reply recipients are absent", async () => {
    const fx = await fixture();
    const agentSessionId = await seedAgentSession(fx);
    const { callbackId, runId, replyToken } = await seedTriggerCallback({
      fixture: fx,
      result: { agentSessionId },
    });
    mockRunOutput("fallback recipient response");

    const response = await postCallback(TRIGGER_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: {
        senderEmail: "sender@example.com",
        agentId: fx.agentId,
        userId: fx.userId,
        inboundEmailId: "email_sender_fallback",
        replyToken,
        runtimeOrgId: fx.orgId,
      },
    });

    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.to).toBe("sender@example.com");
    expect(email.cc).toBeUndefined();
  });

  it("sends the failure message for failed trigger runs", async () => {
    const fx = await fixture();
    const { callbackId, runId, replyToken } = await seedTriggerCallback({
      fixture: fx,
      status: "failed",
    });

    const response = await postCallback(TRIGGER_PATH, {
      callbackId,
      runId,
      status: "failed",
      error: "Agent crashed",
      payload: {
        senderEmail: "sender@example.com",
        agentId: fx.agentId,
        userId: fx.userId,
        inboundEmailId: "email_trigger_failed",
        replyToken,
        runtimeOrgId: fx.orgId,
      },
    });

    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.to).toBe("sender@example.com");
    expect(email.html).toContain("Agent crashed");
  });

  it("no-ops progress callbacks without sending email", async () => {
    const fx = await fixture();
    const { callbackId, runId, replyToken } = await seedTriggerCallback({
      fixture: fx,
      status: "running",
    });

    const response = await postCallback(TRIGGER_PATH, {
      callbackId,
      runId,
      status: "progress",
      payload: {
        senderEmail: fx.userEmail,
        agentId: fx.agentId,
        userId: fx.userId,
        inboundEmailId: "email_trigger_progress",
        replyToken,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    expect(resendMocks.send).not.toHaveBeenCalled();
  });

  it("omits reply continuity when the run result has no agent session id", async () => {
    const fx = await fixture();
    const { callbackId, runId, replyToken } = await seedTriggerCallback({
      fixture: fx,
      result: null,
    });
    mockRunOutput("no continuity response");

    const response = await postCallback(TRIGGER_PATH, {
      callbackId,
      runId,
      status: "completed",
      payload: {
        senderEmail: fx.userEmail,
        agentId: fx.agentId,
        userId: fx.userId,
        inboundEmailId: "email_no_continuity",
        replyToken,
        runtimeOrgId: fx.orgId,
      },
    });

    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.replyTo).toBeUndefined();
    const { thread } = await emailStateAction({
      action: "get-thread",
      reply_token: replyToken,
    });
    expect(thread).toBeNull();
  });
});

describe("POST /api/zero/email/inbound", () => {
  it("rejects missing Svix headers", async () => {
    const response = await requestEmailApp(INBOUND_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "email.received" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Missing signature headers",
    });
  });

  it("records bounced and complained recipients", async () => {
    const fx = await fixture();
    const bounced = `bounce-${fx.orgSlug}@example.com`;
    const complained = fx.userEmail;

    const bounceResponse = await postInbound({
      type: "email.bounced",
      data: { email_id: "email_bounce", to: [bounced] },
    });
    const complaintResponse = await postInbound({
      type: "email.complained",
      data: { email_id: "email_complaint", to: [complained] },
    });

    expect(bounceResponse.status).toBe(200);
    expect(complaintResponse.status).toBe(200);
    const { suppressions } = await emailStateAction({
      action: "get-suppressions",
      emails: [bounced, complained],
    });
    expect(Array.isArray(suppressions)).toBeTruthy();
    expect(
      (suppressions as { emailAddress: string; reason: string }[]).map(
        (row) => {
          return { emailAddress: row.emailAddress, reason: row.reason };
        },
      ),
    ).toStrictEqual(
      expect.arrayContaining([
        { emailAddress: bounced, reason: "bounced" },
        { emailAddress: complained, reason: "complained" },
      ]),
    );
    const { user } = await emailStateAction({
      action: "get-user",
      user_id: fx.userId,
    });
    expect(
      (user as { emailUnsubscribed?: boolean } | null)?.emailUnsubscribed,
    ).toBeTruthy();
  });

  it("dispatches a Zero run for a new org-address email", async () => {
    const fx = await fixture();
    mockReceivedEmail({
      from: fx.userEmail,
      to: [`${fx.orgSlug}@mail.example.com`],
      subject: "Run a report",
      text: "Please run it",
    });
    mockNoAttachments();

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_trigger",
        from: fx.userEmail,
        to: [`${fx.orgSlug}@mail.example.com`],
        subject: "Run a report",
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ received: true });
    await flushWaitUntilForTest();

    const runs = actionRuns(
      await emailStateAction({ action: "get-run-state", fixture: fx }),
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.prompt).toContain("Run a report");
    expect(runs[0]?.triggerSource).toBe("email");
    const callback = runs[0]?.callbacks[0];
    expect(callback?.url).toBe(
      "http://localhost:3000/api/zero/email/callbacks/trigger",
    );
    expect(callback?.payload).toMatchObject({
      senderEmail: fx.userEmail,
      agentId: fx.agentId,
      userId: fx.userId,
      inboundEmailId: "email_trigger",
      runtimeOrgId: fx.orgId,
      replyRecipientTo: [fx.userEmail],
    });
  });

  it("dispatches a continuation run for a reply-address email", async () => {
    const fx = await fixture();
    const agentSessionId = await seedAgentSession(fx);
    const thread = await seedThread({ fixture: fx, agentSessionId });
    mockReceivedEmail({
      from: fx.userEmail,
      to: [`reply+${thread.replyToken}@mail.example.com`],
      subject: "Re: Continue",
      text: "Continue this thread",
    });
    mockNoAttachments();

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_reply",
        from: fx.userEmail,
        to: [`reply+${thread.replyToken}@mail.example.com`],
        subject: "Re: Continue",
      },
    });
    expect(response.status).toBe(200);
    await flushWaitUntilForTest();

    const runs = actionRuns(
      await emailStateAction({ action: "get-run-state", fixture: fx }),
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.sessionId).toBe(agentSessionId);
    const callback = runs[0]?.callbacks[0];
    expect(callback?.url).toBe(
      "http://localhost:3000/api/zero/email/callbacks/reply",
    );
    expect(callback?.payload).toMatchObject({
      emailThreadSessionId: thread.id,
      inboundEmailId: "email_reply",
      replyRecipientTo: [fx.userEmail],
    });
  });

  it("sends an error reply when the reply token is invalid", async () => {
    const fx = await fixture();

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_invalid_reply",
        from: fx.userEmail,
        to: ["reply+bad-token@mail.example.com"],
        subject: "Re: Continue",
      },
    });
    expect(response.status).toBe(200);
    await flushWaitUntilForTest();

    const { outbox } = await emailStateAction({
      action: "get-outbox",
      from_address: "Zero <vm0@mail.example.com>",
    });
    expect(Array.isArray(outbox)).toBeTruthy();
    const outboxItems = outbox as EmailOutboxState[];
    const outboxItem = outboxItems.find((item) => {
      const toAddresses = Array.isArray(item.toAddresses)
        ? item.toAddresses
        : [item.toAddresses];
      return (
        item.subject === "Re: Continue" && toAddresses.includes(fx.userEmail)
      );
    });
    if (!outboxItem) {
      throw new Error(
        `Expected invalid reply outbox email for ${fx.userEmail}`,
      );
    }
    expect(outboxItem).toMatchObject({
      toAddresses: fx.userEmail,
      subject: "Re: Continue",
    });
    expect(outboxItem?.template).toMatchObject({
      template: "inbound-error",
      props: {
        errorMessage: expect.stringContaining(
          "conversation thread has expired",
        ),
      },
    });
  });

  it("rejects invalid Svix signatures", async () => {
    const rawBody = JSON.stringify({ type: "email.received" });
    const response = await requestEmailApp(INBOUND_PATH, {
      method: "POST",
      headers: {
        ...svixHeaders(rawBody),
        "svix-signature": "v1,bad-signature",
      },
      body: rawBody,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Invalid signature",
    });
  });

  it("acknowledges non-received events without background work", async () => {
    const response = await postInbound({
      type: "email.sent",
      data: { email_id: "email_sent" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ received: true });
    await flushWaitUntilForTest();
    expect(resendMocks.receivingGet).not.toHaveBeenCalled();
    expect(resendMocks.send).not.toHaveBeenCalled();
  });

  it("sends an error reply when a continuation reply has empty content", async () => {
    const fx = await fixture();
    const agentSessionId = await seedAgentSession(fx);
    const thread = await seedThread({ fixture: fx, agentSessionId });
    mockReceivedEmail({
      from: fx.userEmail,
      to: [`reply+${thread.replyToken}@mail.example.com`],
      subject: "Re: Empty",
      text: "   ",
      html: "",
    });
    mockNoAttachments();

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_empty_reply",
        from: fx.userEmail,
        to: [`reply+${thread.replyToken}@mail.example.com`],
        subject: "Re: Empty",
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();
    const runs = actionRuns(
      await emailStateAction({ action: "get-run-state", fixture: fx }),
    );
    expect(runs).toHaveLength(0);
    const email = lastSentEmail();
    expect(email.to).toBe(fx.userEmail);
    expect(email.subject).toBe("Re: Empty");
    expect(email.html).toContain("reply was empty");
  });

  it("sends an error reply when a reply sender is not the thread owner", async () => {
    const fx = await fixture();
    const agentSessionId = await seedAgentSession(fx);
    const thread = await seedThread({ fixture: fx, agentSessionId });
    const senderEmail = `other-${fx.orgSlug}@example.com`;
    const otherUserId = `user_${randomUUID()}`;
    await emailStateAction({
      action: "seed-user-cache",
      user_id: otherUserId,
      email: senderEmail,
      name: "Other User",
    });

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_wrong_owner",
        from: senderEmail,
        to: [`reply+${thread.replyToken}@mail.example.com`],
        subject: "Re: Wrong owner",
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();
    expect(resendMocks.receivingGet).not.toHaveBeenCalled();
    const email = lastSentEmail();
    expect(email.to).toBe(senderEmail);
    expect(email.html).toContain("Only the original sender can continue");
  });

  it("sends an error reply when reply sender authentication fails", async () => {
    const fx = await fixture();
    const agentSessionId = await seedAgentSession(fx);
    const thread = await seedThread({ fixture: fx, agentSessionId });
    mockReceivedEmail({
      from: fx.userEmail,
      to: [`reply+${thread.replyToken}@mail.example.com`],
      subject: "Re: Spoofed",
      text: "Reply body",
      headers: {
        "Authentication-Results": "mx.example; dkim=pass; spf=pass; dmarc=fail",
      },
    });

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_reply_dmarc_fail",
        from: fx.userEmail,
        to: [`reply+${thread.replyToken}@mail.example.com`],
        subject: "Re: Spoofed",
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();
    const email = lastSentEmail();
    expect(email.to).toBe(fx.userEmail);
    expect(email.html).toContain("DMARC verification failed");
  });

  it("sends an error reply when a trigger sender is not a workspace member", async () => {
    const fx = await fixture();
    const senderEmail = `nonmember-${fx.orgSlug}@example.com`;
    const senderUserId = `user_${randomUUID()}`;
    await emailStateAction({
      action: "seed-user-cache",
      user_id: senderUserId,
      email: senderEmail,
      name: "Non Member",
    });
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValueOnce(
      { data: [] },
    );

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_not_member",
        from: senderEmail,
        to: [`${fx.orgSlug}@mail.example.com`],
        subject: "Forbidden",
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();
    expect(resendMocks.receivingGet).not.toHaveBeenCalled();
    const email = lastSentEmail();
    expect(email.to).toBe(senderEmail);
    expect(email.subject).toBe("Re: Forbidden");
    expect(email.html).toContain("not a member");
  });

  it("sends an error reply when the workspace has no default agent", async () => {
    const fx = await fixture();
    await emailStateAction({
      action: "delete-org-metadata",
      fixture: fx,
    });

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_no_default_agent",
        from: fx.userEmail,
        to: [`${fx.orgSlug}@mail.example.com`],
        subject: "No default",
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();
    expect(resendMocks.receivingGet).not.toHaveBeenCalled();
    const email = lastSentEmail();
    expect(email.to).toBe(fx.userEmail);
    expect(email.html).toContain("does not have a default agent");
  });

  it("rejects trigger emails that fail DMARC before creating a run", async () => {
    const fx = await fixture();
    mockReceivedEmail({
      from: fx.userEmail,
      to: [`${fx.orgSlug}@mail.example.com`],
      subject: "Spoofed",
      text: "spoofed body",
      headers: {
        "Authentication-Results": "mx.example; dkim=fail; spf=fail; dmarc=none",
      },
    });

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_trigger_dmarc_fail",
        from: fx.userEmail,
        to: [`${fx.orgSlug}@mail.example.com`],
        subject: "Spoofed",
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();
    const runs = actionRuns(
      await emailStateAction({ action: "get-run-state", fixture: fx }),
    );
    expect(runs).toHaveLength(0);
    const email = lastSentEmail();
    expect(email.to).toBe(fx.userEmail);
    expect(email.html).toContain("DMARC verification failed");
  });

  it("extracts trigger prompt content from HTML when text is empty", async () => {
    const fx = await fixture();
    mockReceivedEmail({
      from: fx.userEmail,
      to: [`${fx.orgSlug}@mail.example.com`],
      subject: "Newsletter",
      text: "",
      html: "<p>Rich content from newsletter</p>",
    });
    mockNoAttachments();

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_html_trigger",
        from: fx.userEmail,
        to: [`${fx.orgSlug}@mail.example.com`],
        subject: "Newsletter",
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();
    const [run] = actionRuns(
      await emailStateAction({ action: "get-run-state", fixture: fx }),
    );
    expect(run?.prompt).toContain("Newsletter\n\nRich content from newsletter");
  });

  it("adds mixed attachment results to trigger prompts", async () => {
    const fx = await fixture();
    mockReceivedEmail({
      from: fx.userEmail,
      to: [`${fx.orgSlug}@mail.example.com`],
      subject: "Files",
      text: "Several attachments",
    });
    mockEmailAttachments([
      {
        id: "att-good",
        filename: "report.pdf",
        size: 5000,
        contentType: "application/pdf",
        contentDisposition: "attachment",
        downloadUrl: "https://download.resend.test/report.pdf",
      },
      {
        id: "att-huge",
        filename: "video.mp4",
        size: 15 * 1024 * 1024,
        contentType: "video/mp4",
        contentDisposition: "attachment",
        downloadUrl: "https://download.resend.test/video.mp4",
      },
      {
        id: "att-broken",
        filename: "missing.docx",
        size: 3000,
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        contentDisposition: "attachment",
        downloadUrl: "https://download.resend.test/missing.docx",
      },
    ]);
    mockAttachmentDownload({
      url: "https://download.resend.test/report.pdf",
      body: Buffer.from("pdf-content"),
    });
    mockAttachmentDownload({
      url: "https://download.resend.test/missing.docx",
      status: 404,
    });

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_trigger_attachments",
        from: fx.userEmail,
        to: [`${fx.orgSlug}@mail.example.com`],
        subject: "Files",
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();
    const [run] = actionRuns(
      await emailStateAction({ action: "get-run-state", fixture: fx }),
    );
    expect(run?.prompt).toContain("[attachment]: report.pdf");
    expect(run?.prompt).toContain("https://r2.example.com/upload?sig=test");
    expect(run?.prompt).toContain("video.mp4");
    expect(run?.prompt).toContain("skipped: exceeds size limit");
    expect(run?.prompt).toContain("missing.docx");
    expect(run?.prompt).toContain("skipped: download failed");
    expect(context.mocks.s3.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: "test-user-storages",
          Key: "email-attachments/email_trigger_attachments/att-good-report.pdf",
          Body: expect.any(Buffer),
          ContentType: "application/pdf",
        }),
      }),
    );
  });

  it("replaces inline image data URIs and processes inline attachments", async () => {
    const fx = await fixture();
    const inlineBase64 = "A".repeat(1000);
    mockReceivedEmail({
      from: fx.userEmail,
      to: [`${fx.orgSlug}@mail.example.com`],
      subject: "Photo",
      text: "",
      html: `<p>Look at this</p><img src="data:image/jpeg;base64,${inlineBase64}" alt="photo.jpg">`,
    });
    mockEmailAttachments([
      {
        id: "inline-1",
        filename: "photo.jpg",
        size: 750,
        contentType: "image/jpeg",
        contentDisposition: "inline",
        downloadUrl: "https://download.resend.test/photo.jpg",
      },
    ]);
    mockAttachmentDownload({
      url: "https://download.resend.test/photo.jpg",
      body: Buffer.from("jpeg-content"),
      contentType: "image/jpeg",
    });

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_inline_image",
        from: fx.userEmail,
        to: [`${fx.orgSlug}@mail.example.com`],
        subject: "Photo",
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();
    const [run] = actionRuns(
      await emailStateAction({ action: "get-run-state", fixture: fx }),
    );
    expect(run?.prompt).toContain("Look at this");
    expect(run?.prompt).toContain("[inline image: photo.jpg]");
    expect(run?.prompt).not.toContain("data:image/jpeg;base64");
    expect(run?.prompt).toContain("[attachment]: photo.jpg");
  });

  it("adds attachment results to reply continuation prompts", async () => {
    const fx = await fixture();
    const agentSessionId = await seedAgentSession(fx);
    const thread = await seedThread({ fixture: fx, agentSessionId });
    mockReceivedEmail({
      from: fx.userEmail,
      to: [`reply+${thread.replyToken}@mail.example.com`],
      subject: "Re: File",
      text: "Here is the file",
    });
    mockEmailAttachments([
      {
        id: "reply-att",
        filename: "data.csv",
        size: 200,
        contentType: "text/csv",
        contentDisposition: "attachment",
        downloadUrl: "https://download.resend.test/data.csv",
      },
    ]);
    mockAttachmentDownload({
      url: "https://download.resend.test/data.csv",
      body: Buffer.from("col1,col2\nval1,val2"),
      contentType: "text/csv",
    });

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_reply_attachment",
        from: fx.userEmail,
        to: [`reply+${thread.replyToken}@mail.example.com`],
        subject: "Re: File",
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();
    const [run] = actionRuns(
      await emailStateAction({ action: "get-run-state", fixture: fx }),
    );
    expect(run?.sessionId).toBe(agentSessionId);
    expect(run?.prompt).toContain("Here is the file");
    expect(run?.prompt).toContain("[attachment]: data.csv");
    expect(run?.prompt).toContain("https://r2.example.com/upload?sig=test");
  });

  it("rejects old trigger address formats before fetching email contents", async () => {
    const fx = await fixture();

    for (const address of [
      `${fx.orgSlug}+${fx.agentName}@mail.example.com`,
      `${fx.orgSlug}/${fx.agentName}@mail.example.com`,
      "+invalid@mail.example.com",
    ]) {
      resendMocks.send.mockClear();
      resendMocks.receivingGet.mockClear();

      const response = await postInbound({
        type: "email.received",
        data: {
          email_id: `email_bad_address_${randomUUID()}`,
          from: fx.userEmail,
          to: [address],
          subject: "Bad Address",
        },
      });

      expect(response.status).toBe(200);
      await flushWaitUntilForTest();
      expect(resendMocks.receivingGet).not.toHaveBeenCalled();
      const email = lastSentEmail();
      expect(email.to).toBe(fx.userEmail);
      expect(email.subject).toBe("Re: Bad Address");
    }
  });

  it("sends an error reply when inbound processing throws unexpectedly", async () => {
    const fx = await fixture();
    resendMocks.receivingGet.mockRejectedValueOnce(
      new Error("Resend API unavailable"),
    );

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_unexpected_failure",
        from: fx.userEmail,
        to: [`${fx.orgSlug}@mail.example.com`],
        subject: "Crash",
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();
    const email = lastSentEmail();
    expect(email.to).toBe(fx.userEmail);
    expect(email.subject).toBe("Re: Crash");
    expect(email.html).toContain("internal error occurred");
  });
});
