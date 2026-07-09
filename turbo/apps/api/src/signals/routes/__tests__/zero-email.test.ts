import { createHash, randomUUID } from "node:crypto";

import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";
import { sessionHistoryBlobBodyForKey } from "./helpers/api-bdd-session-history";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";

const context = testContext();
const resendMocks = context.mocks.resend;
const bdd = createBddApi(context);
const runs = createRunsAutomationsApi(context);
const webhooks = createWebhookCallbackApi(context);

const INBOUND_SECRET = "whsec_test";
const REPLY_PATH = "/api/zero/email/callbacks/reply";
const TRIGGER_PATH = "/api/zero/email/callbacks/trigger";

type CapturedDelivery = ReturnType<
  typeof webhooks.captureInternalCallbackDeliveries
>[number];

interface EmailOrgFixture {
  readonly actor: ApiTestUser;
  readonly orgId: string;
  readonly userId: string;
  readonly userEmail: string;
  readonly orgSlug: string;
  readonly agentId: string;
  readonly runnerGroup: string;
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

function clerkUserListEntry(userId: string, email: string) {
  const emailId = `email_${userId}`;
  return {
    id: userId,
    emailAddresses: [{ id: emailId, emailAddress: email }],
    primaryEmailAddressId: emailId,
    firstName: "BDD",
    lastName: "User",
    imageUrl: null,
  };
}

/**
 * Provisions an org whose default agent, entitlement, and model policy are
 * created through the production onboarding, Stripe webhook, and model
 * provider routes. The inbound email flow resolves the org slug and sender
 * email through Clerk (populating caches lazily), so only the Clerk SDK
 * boundary is mocked.
 */
async function emailOrg(): Promise<EmailOrgFixture> {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor");
  }
  const orgId = actor.orgId;
  const orgSlug = `email-${randomUUID().slice(0, 8)}`;
  const runnerGroup = runs.configureRunnerGroup();
  // Object-storage fake: session-history blobs download with deterministic
  // content (so continuation runs resume end to end); everything else acks.
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const input = (command as { readonly input?: { readonly Key?: unknown } })
      .input;
    const key = typeof input?.Key === "string" ? input.Key : "";
    if (key.startsWith("blobs/") && key.endsWith(".blob")) {
      const body = sessionHistoryBlobBodyForKey(context, key);
      return Promise.resolve({
        Body: {
          async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
            if (body) {
              yield body;
            }
          },
        },
      });
    }
    return Promise.resolve({});
  });
  context.mocks.s3.getSignedUrl.mockResolvedValue(
    "https://r2.example.com/upload?sig=test",
  );
  runs.acceptTelemetryIngest();

  const setup = await bdd.setupOnboarding(actor, {
    displayName: "BDD Email Agent",
  });
  const agentId = setup.body.agentId;
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);

  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: orgId,
    slug: orgSlug,
    name: "BDD Email Org",
    createdBy: actor.userId,
  });
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [{ organization: { id: orgId }, role: "org:member" }],
  });

  return {
    actor,
    orgId,
    userId: actor.userId,
    userEmail: actor.email,
    orgSlug,
    agentId,
    runnerGroup,
  };
}

function orgAddress(fx: EmailOrgFixture): string {
  return `${fx.orgSlug}@mail.example.com`;
}

async function postInbound(event: WebhookEvent) {
  return await webhooks.requestResendInboundWebhook(
    event,
    webhooks.signedResendWebhookHeaders(event),
    [200],
  );
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
  readonly from?: string;
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

function sendCallsTo(recipient: string): number {
  return resendMocks.send.mock.calls.filter((call) => {
    const [payload] = call;
    if (typeof payload !== "object" || payload === null || !("to" in payload)) {
      return false;
    }
    const to = payload.to;
    if (typeof to === "string") {
      return to === recipient;
    }
    return Array.isArray(to) && to.includes(recipient);
  }).length;
}

interface ClaimedEmailJob {
  readonly runId: string;
  readonly prompt: string;
  readonly sandboxToken: string;
  readonly cliAgentSessionId: string | null;
}

async function claimEmailJob(runnerGroup: string): Promise<ClaimedEmailJob> {
  const poll = await runs.pollRunner(runnerGroup);
  const job = poll.body.job;
  if (!job) {
    throw new Error("Expected a dispatched email run job");
  }
  const claim = await runs.claimRunnerJob(job.runId);
  return {
    runId: job.runId,
    prompt: job.prompt,
    sandboxToken: claim.sandboxToken,
    cliAgentSessionId: job.cliAgentSessionId ?? null,
  };
}

async function expectNoEmailJob(runnerGroup: string): Promise<void> {
  const poll = await runs.pollRunner(runnerGroup);
  expect(poll.body.job).toBeNull();
}

async function completeEmailRunOk(job: ClaimedEmailJob): Promise<void> {
  const historyHash = createHash("sha256")
    .update(`bdd session history ${job.runId}`)
    .digest("hex");
  await webhooks.requestAgentCheckpoint(
    {
      runId: job.runId,
      cliAgentType: "claude-code",
      cliAgentSessionId: `bdd-email-cli-${job.runId}`,
      cliAgentSessionHistoryHash: historyHash,
    },
    { authorization: `Bearer ${job.sandboxToken}` },
    [200],
  );
  await webhooks.requestAgentComplete(
    { runId: job.runId, exitCode: 0, lastEventSequence: 3 },
    { authorization: `Bearer ${job.sandboxToken}` },
    [200],
  );
  await flushWaitUntilForTest();
}

async function failEmailRun(
  job: ClaimedEmailJob,
  error: string,
): Promise<void> {
  await webhooks.requestAgentComplete(
    { runId: job.runId, exitCode: 1, error },
    { authorization: `Bearer ${job.sandboxToken}` },
    [200],
  );
  await flushWaitUntilForTest();
}

interface TriggerChainOptions {
  readonly subject?: string;
  readonly text?: string;
  readonly html?: string;
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly headers?: Record<string, string>;
  readonly fail?: string;
}

interface CallbackChain {
  readonly job: ClaimedEmailJob;
  readonly delivery: CapturedDelivery;
}

/**
 * Full production trigger chain: inbound org-address email creates the run,
 * the runner claims and finishes it, and the terminal callback dispatch is
 * captured as a legitimately signed HTTP delivery ready for replay.
 */
async function runTriggerChain(
  fx: EmailOrgFixture,
  options: TriggerChainOptions = {},
): Promise<CallbackChain> {
  const subject = options.subject ?? "Email subject";
  mockReceivedEmail({
    from: fx.userEmail,
    to: options.to ?? [orgAddress(fx)],
    cc: options.cc,
    subject,
    text: options.text ?? "Email body",
    html: options.html,
    headers: options.headers,
  });
  mockNoAttachments();
  const deliveries = webhooks.captureInternalCallbackDeliveries(TRIGGER_PATH);

  await postInbound({
    type: "email.received",
    data: {
      email_id: `email_${randomUUID().slice(0, 8)}`,
      from: fx.userEmail,
      to: [orgAddress(fx)],
      subject,
    },
  });
  await flushWaitUntilForTest();

  const job = await claimEmailJob(fx.runnerGroup);
  if (options.fail === undefined) {
    await completeEmailRunOk(job);
  } else {
    await failEmailRun(job, options.fail);
  }

  expect(deliveries).toHaveLength(1);
  return { job, delivery: deliveries[0]! };
}

async function replayCallback(
  path: string,
  delivery: CapturedDelivery,
): Promise<Response> {
  return await webhooks.replayInternalCallback(path, delivery);
}

/**
 * Establishes a live email thread the way production does: the trigger
 * callback replay sends the first agent email whose reply-to address carries
 * the thread token.
 */
async function establishThread(
  fx: EmailOrgFixture,
  options: TriggerChainOptions & { readonly output?: string } = {},
): Promise<{
  readonly replyToken: string;
  readonly firstEmail: SentEmail;
  readonly triggerRunId: string;
}> {
  const chain = await runTriggerChain(fx, options);
  mockRunOutput(options.output ?? "first trigger output");
  const response = await replayCallback(TRIGGER_PATH, chain.delivery);
  expect(response.status).toBe(200);
  const firstEmail = lastSentEmail();
  const token = firstEmail.replyTo?.match(/^reply\+(.+)@mail\.example\.com$/);
  if (!token?.[1]) {
    throw new Error("Expected the trigger email to carry a reply token");
  }
  return { replyToken: token[1], firstEmail, triggerRunId: chain.job.runId };
}

function replyAddress(replyToken: string): string {
  return `reply+${replyToken}@mail.example.com`;
}

interface ReplyChainOptions {
  readonly subject?: string;
  readonly text?: string;
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly headers?: Record<string, string>;
  readonly fail?: string;
}

async function runReplyChain(
  fx: EmailOrgFixture,
  replyToken: string,
  options: ReplyChainOptions = {},
): Promise<CallbackChain> {
  const subject = options.subject ?? "Re: Email subject";
  mockReceivedEmail({
    from: fx.userEmail,
    to: options.to ?? [replyAddress(replyToken)],
    cc: options.cc,
    subject,
    text: options.text ?? "Continue this thread",
    headers: options.headers,
  });
  mockNoAttachments();
  const deliveries = webhooks.captureInternalCallbackDeliveries(REPLY_PATH);

  await postInbound({
    type: "email.received",
    data: {
      email_id: `email_${randomUUID().slice(0, 8)}`,
      from: fx.userEmail,
      to: [replyAddress(replyToken)],
      subject,
    },
  });
  await flushWaitUntilForTest();

  const job = await claimEmailJob(fx.runnerGroup);
  if (options.fail === undefined) {
    await completeEmailRunOk(job);
  } else {
    await failEmailRun(job, options.fail);
  }

  expect(deliveries).toHaveLength(1);
  return { job, delivery: deliveries[0]! };
}

interface DeliveryEnvelope {
  readonly status?: string;
  readonly runId?: string;
  readonly payload?: Record<string, unknown>;
}

function deliveryEnvelope(delivery: CapturedDelivery): DeliveryEnvelope {
  return JSON.parse(delivery.body) as DeliveryEnvelope;
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
  it("rejects tampered signatures and expired timestamps on both callback paths", async () => {
    const fx = await emailOrg();
    const { delivery } = await runTriggerChain(fx, { subject: "Sig checks" });

    // The dispatcher's signature is bound to the callback secret, so a
    // tampered signature is rejected on the trigger path...
    const tamperedTrigger = await replayCallback(TRIGGER_PATH, {
      ...delivery,
      headers: {
        ...delivery.headers,
        "x-vm0-signature": webhooks.tamperedSignature(delivery),
      },
    });
    expect(tamperedTrigger.status).toBe(401);
    await expect(tamperedTrigger.json()).resolves.toStrictEqual({
      error: "Invalid signature",
    });

    // ...and on the reply path, which shares the signature verification.
    const tamperedReply = await replayCallback(REPLY_PATH, {
      ...delivery,
      headers: {
        ...delivery.headers,
        "x-vm0-signature": webhooks.tamperedSignature(delivery),
      },
    });
    expect(tamperedReply.status).toBe(401);
    await expect(tamperedReply.json()).resolves.toStrictEqual({
      error: "Invalid signature",
    });

    // A correctly signed delivery replayed long after dispatch is rejected
    // by the timestamp window.
    mockNow(now() + 1_000_000);
    const expired = await replayCallback(TRIGGER_PATH, delivery);
    expect(expired.status).toBe(401);
    await expect(expired.json()).resolves.toStrictEqual({
      error: "Timestamp expired",
    });
    clearMockNow();

    // The untouched delivery still verifies.
    mockRunOutput("verified output");
    const accepted = await replayCallback(TRIGGER_PATH, delivery);
    expect(accepted.status).toBe(200);
  });

  it("sends a reply email with inbound threading headers after completion", async () => {
    const fx = await emailOrg();
    const { replyToken } = await establishThread(fx, { subject: "Report" });

    const { job, delivery } = await runReplyChain(fx, replyToken, {
      subject: "Re: Report",
      text: "summarize email",
      to: [replyAddress(replyToken), "teammate@example.com"],
      cc: ["cc@example.com"],
      headers: {
        "Authentication-Results": "mx.example; dmarc=pass",
        "Message-ID": "<inbound@example.com>",
        References: "<root@example.com>",
      },
    });
    mockRunOutput("final email answer");

    const response = await replayCallback(REPLY_PATH, delivery);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    expect(resendMocks.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        from: `Zero <${fx.orgSlug}@mail.example.com>`,
        to: [fx.userEmail, "teammate@example.com"],
        cc: ["cc@example.com"],
        replyTo: replyAddress(replyToken),
        subject: expect.stringMatching(
          /^Re: VM0 - Automation run for ".+" completed$/,
        ),
        headers: expect.objectContaining({
          "In-Reply-To": "<inbound@example.com>",
          References: "<root@example.com> <inbound@example.com>",
        }),
      }),
    );
    const email = lastSentEmail();
    expect(email.html).toContain("final email answer");
    expect(email.html).not.toContain(`/activities/${job.runId}`);
  });

  it("includes the audit log link when the AuditLink switch is enabled", async () => {
    const fx = await emailOrg();
    const { replyToken } = await establishThread(fx);
    const { job, delivery } = await runReplyChain(fx, replyToken);
    await updateFeatureSwitchesForUser(
      context,
      { userId: fx.userId, orgId: fx.orgId },
      { [FeatureSwitchKey.ZeroDebug]: true },
    );
    mockRunOutput("audited email answer");

    const response = await replayCallback(REPLY_PATH, delivery);
    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.html).toContain(`/activities/${job.runId}`);
  });

  it("falls back to the last sent email message id when inbound threading headers are missing", async () => {
    const fx = await emailOrg();
    // The trigger email's Resend message id becomes the thread's last
    // message id through the production send path.
    const { replyToken } = await establishThread(fx);
    const { delivery } = await runReplyChain(fx, replyToken, {
      headers: { "Authentication-Results": "mx.example; dmarc=pass" },
    });
    mockRunOutput("fallback threading answer");

    const response = await replayCallback(REPLY_PATH, delivery);
    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.headers?.["In-Reply-To"]).toBe("<sent@example.com>");
    expect(email.headers?.References).toBe("<sent@example.com>");
  });

  it("uses the last sent message id in references when only the inbound message id is present", async () => {
    const fx = await emailOrg();
    const { replyToken } = await establishThread(fx);
    const { delivery } = await runReplyChain(fx, replyToken, {
      headers: {
        "Authentication-Results": "mx.example; dmarc=pass",
        "Message-ID": "<inbound@example.com>",
      },
    });
    mockRunOutput("partial threading answer");

    const response = await replayCallback(REPLY_PATH, delivery);
    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.headers?.["In-Reply-To"]).toBe("<inbound@example.com>");
    expect(email.headers?.References).toBe(
      "<sent@example.com> <inbound@example.com>",
    );
  });

  it("omits threading headers when neither inbound nor session message ids exist", async () => {
    const fx = await emailOrg();
    // Resend does not report a message id for the trigger email, so the
    // thread is saved without a last message id.
    resendMocks.get.mockResolvedValue({ data: {} });
    const { replyToken } = await establishThread(fx);
    const { delivery } = await runReplyChain(fx, replyToken, {
      headers: { "Authentication-Results": "mx.example; dmarc=pass" },
    });
    mockRunOutput("no threading answer");

    const response = await replayCallback(REPLY_PATH, delivery);
    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.headers?.["In-Reply-To"]).toBeUndefined();
    expect(email.headers?.References).toBeUndefined();
  });

  it("sends the failure message when the reply run fails", async () => {
    const fx = await emailOrg();
    const { replyToken } = await establishThread(fx);
    const { delivery } = await runReplyChain(fx, replyToken, {
      fail: "Agent crashed",
    });

    const response = await replayCallback(REPLY_PATH, delivery);
    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.to).toStrictEqual([fx.userEmail]);
    expect(email.subject).toMatch(
      /^Re: VM0 - Automation run for ".+" completed$/,
    );
    expect(email.html).toContain("Agent crashed");
  });
});

describe("POST /api/zero/email/callbacks/trigger", () => {
  it("skips before callback verification when Resend is not configured", async () => {
    mockEnv("RESEND_API_KEY", undefined);

    const response = await webhooks.requestEmailTriggerCallback(
      {
        runId: randomUUID(),
        status: "completed",
        payload: {
          senderEmail: "sender@example.com",
          agentId: randomUUID(),
          userId: `user_${randomUUID()}`,
          inboundEmailId: "email_unconfigured",
          replyToken: "token",
        },
      },
      [200],
    );
    expect(response.body).toStrictEqual({ success: true, skipped: true });
  });

  it("sends a response email and creates the thread session", async () => {
    const fx = await emailOrg();
    const { job, delivery } = await runTriggerChain(fx, {
      subject: "Need help",
      text: "Please help",
      to: [orgAddress(fx)],
      cc: ["cc@example.com"],
      headers: {
        "Authentication-Results": "mx.example; dmarc=pass",
        "Message-ID": "<inbound@example.com>",
        References: "<root@example.com>",
      },
    });
    expect(deliveryEnvelope(delivery)).toMatchObject({
      status: "completed",
      runId: job.runId,
      payload: {
        senderEmail: fx.userEmail,
        agentId: fx.agentId,
        userId: fx.userId,
        runtimeOrgId: fx.orgId,
        subject: "Need help",
        inboundMessageId: "<inbound@example.com>",
        replyRecipientTo: [fx.userEmail],
        replyRecipientCc: ["cc@example.com"],
      },
    });
    mockRunOutput("trigger response");

    const response = await replayCallback(TRIGGER_PATH, delivery);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    expect(resendMocks.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        from: `Zero <${fx.orgSlug}@mail.example.com>`,
        to: [fx.userEmail],
        cc: ["cc@example.com"],
        replyTo: expect.stringMatching(/^reply\+.+@mail\.example\.com$/),
        subject: "Re: Need help",
        headers: expect.objectContaining({
          "In-Reply-To": "<inbound@example.com>",
          References: "<root@example.com> <inbound@example.com>",
        }),
      }),
    );
    const email = lastSentEmail();
    expect(email.html).toContain("trigger response");
    expect(email.html).not.toContain(`/activities/${job.runId}`);
  });

  it("includes the audit log link when the AuditLink switch is enabled", async () => {
    const fx = await emailOrg();
    const { job, delivery } = await runTriggerChain(fx);
    await updateFeatureSwitchesForUser(
      context,
      { userId: fx.userId, orgId: fx.orgId },
      { [FeatureSwitchKey.ZeroDebug]: true },
    );
    mockRunOutput("audited trigger response");

    const response = await replayCallback(TRIGGER_PATH, delivery);
    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.html).toContain(`/activities/${job.runId}`);
  });

  it("strips an existing Re prefix from the trigger subject", async () => {
    const fx = await emailOrg();
    const { delivery } = await runTriggerChain(fx, {
      subject: "Re: Original Topic",
    });
    mockRunOutput("subject normalized response");

    const response = await replayCallback(TRIGGER_PATH, delivery);
    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.subject).toBe("Re: Original Topic");
  });

  it("sends the failure message without reply continuity for failed trigger runs", async () => {
    const fx = await emailOrg();
    const { delivery } = await runTriggerChain(fx, {
      subject: "Doomed task",
      fail: "Agent crashed",
    });

    const response = await replayCallback(TRIGGER_PATH, delivery);
    expect(response.status).toBe(200);
    const email = lastSentEmail();
    expect(email.to).toStrictEqual([fx.userEmail]);
    expect(email.subject).toBe("Re: Doomed task");
    expect(email.html).toContain("Agent crashed");
    // A failed run has no agent session to continue, so the failure email
    // does not offer a reply address.
    expect(email.replyTo).toBeUndefined();
  });
});

describe("POST /api/zero/email/inbound", () => {
  it("rejects missing Svix headers", async () => {
    const response = await webhooks.requestResendInboundWebhook(
      { type: "email.received" },
      {},
      [401],
    );
    expect(response.body).toStrictEqual({
      error: "Missing signature headers",
    });
  });

  it("rejects invalid Svix signatures", async () => {
    const event = { type: "email.received" };
    const response = await webhooks.requestResendInboundWebhook(
      event,
      {
        ...webhooks.signedResendWebhookHeaders(event),
        "svix-signature": "v1,bad-signature",
      },
      [401],
    );
    expect(response.body).toStrictEqual({ error: "Invalid signature" });
  });

  it("suppresses bounced and complained recipients from future error replies", async () => {
    const bounced = `bounced-${randomUUID().slice(0, 10)}@example.test`;
    const complained = `complained-${randomUUID().slice(0, 10)}@example.test`;
    const control = `control-${randomUUID().slice(0, 10)}@example.test`;
    // None of the recipients has a vm0 account.
    context.mocks.clerk.users.getUserList.mockResolvedValue({ data: [] });

    await postInbound({
      type: "email.bounced",
      data: { email_id: `email_${randomUUID().slice(0, 8)}`, to: [bounced] },
    });
    await postInbound({
      type: "email.complained",
      data: { email_id: `email_${randomUUID().slice(0, 8)}`, to: [complained] },
    });

    // Senders without a vm0 account receive an error reply; a suppressed
    // recipient must not.
    context.mocks.clerk.users.getUserList.mockResolvedValue({ data: [] });
    for (const sender of [control, bounced, complained]) {
      await postInbound({
        type: "email.received",
        data: {
          email_id: `email_${randomUUID().slice(0, 8)}`,
          from: sender,
          to: ["bdd-unknown-org@mail.example.com"],
          subject: "Suppression probe",
        },
      });
      await flushWaitUntilForTest();
    }

    expect(sendCallsTo(control)).toBe(1);
    expect(sendCallsTo(bounced)).toBe(0);
    expect(sendCallsTo(complained)).toBe(0);
  });

  it("dispatches a Zero run for a new org-address email", async () => {
    const fx = await emailOrg();
    mockReceivedEmail({
      from: fx.userEmail,
      to: [orgAddress(fx)],
      subject: "Run a report",
      text: "Please run it",
    });
    mockNoAttachments();
    const deliveries = webhooks.captureInternalCallbackDeliveries(TRIGGER_PATH);

    const response = await postInbound({
      type: "email.received",
      data: {
        email_id: "email_trigger",
        from: fx.userEmail,
        to: [orgAddress(fx)],
        subject: "Run a report",
      },
    });
    expect(response.body).toStrictEqual({ received: true });
    await flushWaitUntilForTest();

    const job = await claimEmailJob(fx.runnerGroup);
    expect(job.prompt).toContain("Run a report");
    expect(job.prompt).toContain("Please run it");

    // Completing the run dispatches the trigger callback to the production
    // callback URL with the inbound context.
    await completeEmailRunOk(job);
    expect(deliveries).toHaveLength(1);
    expect(deliveryEnvelope(deliveries[0]!)).toMatchObject({
      runId: job.runId,
      payload: {
        senderEmail: fx.userEmail,
        agentId: fx.agentId,
        userId: fx.userId,
        inboundEmailId: "email_trigger",
        runtimeOrgId: fx.orgId,
        replyRecipientTo: [fx.userEmail],
      },
    });
  });

  it("dispatches a continuation run for a reply-address email", async () => {
    const fx = await emailOrg();
    const { replyToken, triggerRunId } = await establishThread(fx, {
      subject: "Continue",
    });

    const { job, delivery } = await runReplyChain(fx, replyToken, {
      subject: "Re: Continue",
      text: "Continue this thread",
    });

    // The continuation run resumes the same CLI agent session that the
    // trigger run checkpointed.
    expect(job.cliAgentSessionId).toBe(`bdd-email-cli-${triggerRunId}`);
    expect(deliveryEnvelope(delivery)).toMatchObject({
      runId: job.runId,
      payload: {
        replyRecipientTo: [fx.userEmail],
      },
    });
  });

  it("sends an error reply when the reply token is invalid", async () => {
    const fx = await emailOrg();

    await postInbound({
      type: "email.received",
      data: {
        email_id: "email_invalid_reply",
        from: fx.userEmail,
        to: ["reply+bad-token@mail.example.com"],
        subject: "Re: Continue",
      },
    });
    await flushWaitUntilForTest();

    const email = lastSentEmail();
    expect(email.to).toBe(fx.userEmail);
    expect(email.subject).toBe("Re: Continue");
    expect(email.html).toContain("conversation thread has expired");
  });

  it("acknowledges non-received events without background work", async () => {
    const response = await postInbound({
      type: "email.sent",
      data: { email_id: "email_sent" },
    });

    expect(response.body).toStrictEqual({ received: true });
    await flushWaitUntilForTest();
    expect(resendMocks.receivingGet).not.toHaveBeenCalled();
    expect(resendMocks.send).not.toHaveBeenCalled();
  });

  it("sends an error reply when a continuation reply has empty content", async () => {
    const fx = await emailOrg();
    const { replyToken } = await establishThread(fx);
    mockReceivedEmail({
      from: fx.userEmail,
      to: [replyAddress(replyToken)],
      subject: "Re: Empty",
      text: "   ",
      html: "",
    });
    mockNoAttachments();

    await postInbound({
      type: "email.received",
      data: {
        email_id: "email_empty_reply",
        from: fx.userEmail,
        to: [replyAddress(replyToken)],
        subject: "Re: Empty",
      },
    });
    await flushWaitUntilForTest();

    await expectNoEmailJob(fx.runnerGroup);
    const email = lastSentEmail();
    expect(email.to).toBe(fx.userEmail);
    expect(email.subject).toBe("Re: Empty");
    expect(email.html).toContain("reply was empty");
  });

  it("sends an error reply when a reply sender is not the thread owner", async () => {
    const fx = await emailOrg();
    const { replyToken } = await establishThread(fx);
    const senderEmail = `other-${fx.orgSlug}@example.com`;
    const otherUserId = `user_${randomUUID()}`;
    context.mocks.clerk.users.getUserList.mockResolvedValueOnce({
      data: [clerkUserListEntry(otherUserId, senderEmail)],
    });
    resendMocks.receivingGet.mockClear();
    resendMocks.send.mockClear();

    await postInbound({
      type: "email.received",
      data: {
        email_id: "email_wrong_owner",
        from: senderEmail,
        to: [replyAddress(replyToken)],
        subject: "Re: Wrong owner",
      },
    });
    await flushWaitUntilForTest();

    expect(resendMocks.receivingGet).not.toHaveBeenCalled();
    const email = lastSentEmail();
    expect(email.to).toBe(senderEmail);
    expect(email.html).toContain("Only the original sender can continue");
  });

  it("sends an error reply when reply sender authentication fails", async () => {
    const fx = await emailOrg();
    const { replyToken } = await establishThread(fx);
    mockReceivedEmail({
      from: fx.userEmail,
      to: [replyAddress(replyToken)],
      subject: "Re: Spoofed",
      text: "Reply body",
      headers: {
        "Authentication-Results": "mx.example; dkim=pass; spf=pass; dmarc=fail",
      },
    });

    await postInbound({
      type: "email.received",
      data: {
        email_id: "email_reply_dmarc_fail",
        from: fx.userEmail,
        to: [replyAddress(replyToken)],
        subject: "Re: Spoofed",
      },
    });
    await flushWaitUntilForTest();

    await expectNoEmailJob(fx.runnerGroup);
    const email = lastSentEmail();
    expect(email.to).toBe(fx.userEmail);
    expect(email.html).toContain("DMARC verification failed");
  });

  it("sends an error reply when a trigger sender is not a workspace member", async () => {
    const fx = await emailOrg();
    const senderEmail = `nonmember-${fx.orgSlug}@example.com`;
    const senderUserId = `user_${randomUUID()}`;
    context.mocks.clerk.users.getUserList.mockResolvedValueOnce({
      data: [clerkUserListEntry(senderUserId, senderEmail)],
    });
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValueOnce(
      { data: [] },
    );

    await postInbound({
      type: "email.received",
      data: {
        email_id: "email_not_member",
        from: senderEmail,
        to: [orgAddress(fx)],
        subject: "Forbidden",
      },
    });
    await flushWaitUntilForTest();

    expect(resendMocks.receivingGet).not.toHaveBeenCalled();
    const email = lastSentEmail();
    expect(email.to).toBe(senderEmail);
    expect(email.subject).toBe("Re: Forbidden");
    expect(email.html).toContain("not a member");
  });

  it("sends an error reply when the workspace has no default agent", async () => {
    // A user whose org never completed onboarding has no default agent.
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }
    const orgSlug = `email-${randomUUID().slice(0, 8)}`;
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [clerkUserListEntry(actor.userId, actor.email)],
    });
    context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
      id: actor.orgId,
      slug: orgSlug,
      name: "BDD Bare Org",
      createdBy: actor.userId,
    });
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [{ organization: { id: actor.orgId }, role: "org:member" }],
    });

    await postInbound({
      type: "email.received",
      data: {
        email_id: "email_no_default_agent",
        from: actor.email,
        to: [`${orgSlug}@mail.example.com`],
        subject: "No default",
      },
    });
    await flushWaitUntilForTest();

    expect(resendMocks.receivingGet).not.toHaveBeenCalled();
    const email = lastSentEmail();
    expect(email.to).toBe(actor.email);
    expect(email.html).toContain("does not have a default agent");
  });

  it("rejects trigger emails that fail DMARC before creating a run", async () => {
    const fx = await emailOrg();
    mockReceivedEmail({
      from: fx.userEmail,
      to: [orgAddress(fx)],
      subject: "Spoofed",
      text: "spoofed body",
      headers: {
        "Authentication-Results": "mx.example; dkim=fail; spf=fail; dmarc=none",
      },
    });

    await postInbound({
      type: "email.received",
      data: {
        email_id: "email_trigger_dmarc_fail",
        from: fx.userEmail,
        to: [orgAddress(fx)],
        subject: "Spoofed",
      },
    });
    await flushWaitUntilForTest();

    await expectNoEmailJob(fx.runnerGroup);
    const email = lastSentEmail();
    expect(email.to).toBe(fx.userEmail);
    expect(email.html).toContain("DMARC verification failed");
  });

  it("extracts trigger prompt content from HTML when text is empty", async () => {
    const fx = await emailOrg();
    mockReceivedEmail({
      from: fx.userEmail,
      to: [orgAddress(fx)],
      subject: "Newsletter",
      text: "",
      html: "<p>Rich content from newsletter</p>",
    });
    mockNoAttachments();

    await postInbound({
      type: "email.received",
      data: {
        email_id: "email_html_trigger",
        from: fx.userEmail,
        to: [orgAddress(fx)],
        subject: "Newsletter",
      },
    });
    await flushWaitUntilForTest();

    const job = await claimEmailJob(fx.runnerGroup);
    expect(job.prompt).toContain("Newsletter\n\nRich content from newsletter");
  });

  it("adds mixed attachment results to trigger prompts", async () => {
    const fx = await emailOrg();
    mockReceivedEmail({
      from: fx.userEmail,
      to: [orgAddress(fx)],
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

    await postInbound({
      type: "email.received",
      data: {
        email_id: "email_trigger_attachments",
        from: fx.userEmail,
        to: [orgAddress(fx)],
        subject: "Files",
      },
    });
    await flushWaitUntilForTest();

    const job = await claimEmailJob(fx.runnerGroup);
    expect(job.prompt).toContain("[attachment]: report.pdf");
    expect(job.prompt).toContain("https://r2.example.com/upload?sig=test");
    expect(job.prompt).toContain("video.mp4");
    expect(job.prompt).toContain("skipped: exceeds size limit");
    expect(job.prompt).toContain("missing.docx");
    expect(job.prompt).toContain("skipped: download failed");
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
    const fx = await emailOrg();
    const inlineBase64 = "A".repeat(1000);
    mockReceivedEmail({
      from: fx.userEmail,
      to: [orgAddress(fx)],
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

    await postInbound({
      type: "email.received",
      data: {
        email_id: "email_inline_image",
        from: fx.userEmail,
        to: [orgAddress(fx)],
        subject: "Photo",
      },
    });
    await flushWaitUntilForTest();

    const job = await claimEmailJob(fx.runnerGroup);
    expect(job.prompt).toContain("Look at this");
    expect(job.prompt).toContain("[inline image: photo.jpg]");
    expect(job.prompt).not.toContain("data:image/jpeg;base64");
    expect(job.prompt).toContain("[attachment]: photo.jpg");
  });

  it("adds attachment results to reply continuation prompts", async () => {
    const fx = await emailOrg();
    const { replyToken } = await establishThread(fx);
    mockReceivedEmail({
      from: fx.userEmail,
      to: [replyAddress(replyToken)],
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

    await postInbound({
      type: "email.received",
      data: {
        email_id: "email_reply_attachment",
        from: fx.userEmail,
        to: [replyAddress(replyToken)],
        subject: "Re: File",
      },
    });
    await flushWaitUntilForTest();

    const job = await claimEmailJob(fx.runnerGroup);
    expect(job.prompt).toContain("Here is the file");
    expect(job.prompt).toContain("[attachment]: data.csv");
    expect(job.prompt).toContain("https://r2.example.com/upload?sig=test");
  });

  it("rejects old trigger address formats before fetching email contents", async () => {
    const fx = await emailOrg();

    for (const address of [
      `${fx.orgSlug}+agent@mail.example.com`,
      `${fx.orgSlug}/agent@mail.example.com`,
      "+invalid@mail.example.com",
    ]) {
      resendMocks.send.mockClear();
      resendMocks.receivingGet.mockClear();

      await postInbound({
        type: "email.received",
        data: {
          email_id: `email_bad_address_${randomUUID()}`,
          from: fx.userEmail,
          to: [address],
          subject: "Bad Address",
        },
      });
      await flushWaitUntilForTest();

      expect(resendMocks.receivingGet).not.toHaveBeenCalled();
      const email = lastSentEmail();
      expect(email.to).toBe(fx.userEmail);
      expect(email.subject).toBe("Re: Bad Address");
    }
  });

  it("sends an error reply when inbound processing throws unexpectedly", async () => {
    const fx = await emailOrg();
    resendMocks.receivingGet.mockRejectedValueOnce(
      new Error("Resend API unavailable"),
    );

    await postInbound({
      type: "email.received",
      data: {
        email_id: "email_unexpected_failure",
        from: fx.userEmail,
        to: [orgAddress(fx)],
        subject: "Crash",
      },
    });
    await flushWaitUntilForTest();

    const email = lastSentEmail();
    expect(email.to).toBe(fx.userEmail);
    expect(email.subject).toBe("Re: Crash");
    expect(email.html).toContain("internal error occurred");
  });
});
