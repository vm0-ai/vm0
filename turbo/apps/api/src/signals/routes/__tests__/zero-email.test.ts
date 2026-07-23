import { createHash, randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { beforeEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createEmailApi } from "./helpers/api-bdd-email";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  seedAgentRunCallback$,
  seedEmailThreadSession$,
} from "./helpers/agent-run-callback";

const context = testContext();
const resendMocks = context.mocks.resend;
const bdd = createBddApi(context);
const email = createEmailApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const callbackStore = createStore();

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

interface ClaimedEmailJob {
  readonly runId: string;
  readonly sandboxToken: string;
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

async function emailOrg(): Promise<EmailOrgFixture> {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor");
  }
  const orgId = actor.orgId;
  const orgSlug = `email-${randomUUID().slice(0, 8)}`;
  const runnerGroup = runs.configureRunnerGroup();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();

  const agentId = await bdd.bootstrapOnboarding(actor, {
    displayName: "BDD Email Agent",
  });
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  await runs.heartbeatRunner(runnerGroup);

  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [clerkUserListEntry(actor.userId, actor.email)],
  });
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

async function postInbound(event: WebhookEvent) {
  return await webhooks.requestResendInboundWebhook(
    event,
    webhooks.signedResendWebhookHeaders(event),
    [200],
  );
}

async function claimEmailJob(runnerGroup: string): Promise<ClaimedEmailJob> {
  const poll = await runs.pollRunner(runnerGroup);
  const job = poll.body.job;
  if (!job) {
    throw new Error("Expected a dispatched legacy email run job");
  }
  const claim = await runs.claimRunnerJob(job.runId);
  return { runId: job.runId, sandboxToken: claim.sandboxToken };
}

async function completeEmailRun(job: ClaimedEmailJob): Promise<void> {
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

async function createLegacyEmailRun(
  fx: EmailOrgFixture,
  args: {
    readonly prompt: string;
    readonly callbackPath: string;
    readonly callbackPayloads: readonly Record<string, unknown>[];
  },
): Promise<{
  readonly job: ClaimedEmailJob;
  readonly sessionId: string;
  readonly deliveries: readonly CapturedDelivery[];
}> {
  const created = await runs.createRun(fx.actor, {
    agentId: fx.agentId,
    prompt: args.prompt,
    modelProvider: "anthropic-api-key",
  });
  await runs.heartbeatRunner(fx.runnerGroup);
  await flushWaitUntilForTest();
  // The retired inbound endpoint can no longer create this historical state.
  // Seed only the already-persisted callback that a pre-rollout run would have.
  for (const payload of args.callbackPayloads) {
    await callbackStore.set(
      seedAgentRunCallback$,
      {
        runId: created.runId,
        url: `http://localhost:3000${args.callbackPath}`,
        payload,
        secret: `retired-email-${randomUUID()}`,
      },
      context.signal,
    );
  }

  const deliveries = webhooks.captureInternalCallbackDeliveries(
    args.callbackPath,
  );
  const job = await claimEmailJob(fx.runnerGroup);
  await completeEmailRun(job);
  expect(deliveries).toHaveLength(args.callbackPayloads.length);
  return { job, sessionId: created.sessionId, deliveries };
}

function deliveryPayload(delivery: CapturedDelivery): Record<string, unknown> {
  const envelope = JSON.parse(delivery.body) as {
    readonly payload?: unknown;
  };
  if (
    typeof envelope.payload !== "object" ||
    envelope.payload === null ||
    Array.isArray(envelope.payload)
  ) {
    throw new Error("Expected callback delivery payload");
  }
  return envelope.payload as Record<string, unknown>;
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
    return typeof to === "string"
      ? to === recipient
      : Array.isArray(to) && to.includes(recipient);
  }).length;
}

beforeEach(() => {
  resendMocks.send.mockReset();
  resendMocks.get.mockReset();
  resendMocks.receivingGet.mockReset();
  resendMocks.attachmentsList.mockReset();
  context.mocks.axiom.query.mockReset();
  resendMocks.send.mockResolvedValue({ data: { id: "resend-test-id" } });
  resendMocks.get.mockResolvedValue({
    data: { message_id: "<sent@example.com>" },
  });
  mockEnv("RESEND_API_KEY", "test-resend-key");
  mockEnv("RESEND_WEBHOOK_SECRET", INBOUND_SECRET);
  mockEnv("RESEND_FROM_DOMAIN", "mail.example.com");
});

describe("POST /api/zero/email/inbound", () => {
  it("rejects missing or invalid Svix signatures", async () => {
    const missingHeaders = await webhooks.requestResendInboundWebhook(
      { type: "email.received" },
      {},
      [401],
    );
    expect(missingHeaders.body).toStrictEqual({
      error: "Missing signature headers",
    });

    const event = { type: "email.received" };
    const invalidSignature = await webhooks.requestResendInboundWebhook(
      event,
      {
        ...webhooks.signedResendWebhookHeaders(event),
        "svix-signature": "v1,bad-signature",
      },
      [401],
    );
    expect(invalidSignature.body).toStrictEqual({
      error: "Invalid signature",
    });
  });

  it("sends data-export email to eligible recipients", async () => {
    const controlActor = bdd.user();

    await email.enqueueDataExportEmail(controlActor);
    const drain = await email.drainEmailOutboxCron(true);
    expect(drain.status).toBe(200);
    expect(sendCallsTo(controlActor.email)).toBe(1);
  });

  it("keeps bounced recipients out of transactional sends", async () => {
    const bouncedActor = bdd.user();

    await postInbound({
      type: "email.bounced",
      data: {
        email_id: `email_${randomUUID()}`,
        to: [bouncedActor.email],
      },
    });

    await email.enqueueDataExportEmail(bouncedActor);
    const drain = await email.drainEmailOutboxCron(true);
    expect(drain.status).toBe(200);
    expect(sendCallsTo(bouncedActor.email)).toBe(0);
  });

  it("keeps complained recipients out of transactional sends", async () => {
    const complainedActor = bdd.user();
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [clerkUserListEntry(complainedActor.userId, complainedActor.email)],
    });

    await postInbound({
      type: "email.complained",
      data: {
        email_id: `email_${randomUUID()}`,
        to: [complainedActor.email],
      },
    });

    await email.enqueueDataExportEmail(complainedActor);
    const drain = await email.drainEmailOutboxCron(true);
    expect(drain.status).toBe(200);
    expect(sendCallsTo(complainedActor.email)).toBe(0);
  });

  it("acknowledges new and reply-address email without creating Agent runs", async () => {
    const fx = await emailOrg();
    for (const to of [
      `${fx.orgSlug}@mail.example.com`,
      `reply+retired-${randomUUID()}@mail.example.com`,
    ]) {
      const response = await postInbound({
        type: "email.received",
        data: {
          email_id: `email_${randomUUID()}`,
          from: fx.userEmail,
          to: [to],
          subject: "Retired channel",
        },
      });
      expect(response.body).toStrictEqual({ received: true });
    }

    await flushWaitUntilForTest();
    const poll = await runs.pollRunner(fx.runnerGroup);
    expect(poll.body.job).toBeNull();
    expect(resendMocks.receivingGet).not.toHaveBeenCalled();
    expect(resendMocks.attachmentsList).not.toHaveBeenCalled();
    expect(resendMocks.send).not.toHaveBeenCalled();
  });

  it("acknowledges unrelated signed Resend events without background work", async () => {
    const response = await postInbound({
      type: "email.sent",
      data: { email_id: "email_sent" },
    });

    expect(response.body).toStrictEqual({ received: true });
    await flushWaitUntilForTest();
    expect(resendMocks.receivingGet).not.toHaveBeenCalled();
    expect(resendMocks.send).not.toHaveBeenCalled();
  });
});

describe("pre-shutdown Agent Email completion compatibility", () => {
  it("completes an already-running trigger callback", async () => {
    const fx = await emailOrg();
    const replyToken = `retired-${randomUUID()}`;
    const trigger = await createLegacyEmailRun(fx, {
      prompt: "Legacy trigger prompt",
      callbackPath: TRIGGER_PATH,
      callbackPayloads: [
        {
          senderEmail: fx.userEmail,
          agentId: fx.agentId,
          userId: fx.userId,
          inboundEmailId: `email_${randomUUID()}`,
          replyToken,
          inboundMessageId: "<trigger-inbound@example.com>",
          inboundReferences: "<root@example.com>",
          subject: "Legacy request",
          runtimeOrgId: fx.orgId,
          replyRecipientTo: [fx.userEmail],
          replyRecipientCc: [],
        },
      ],
    });
    mockRunOutput("legacy trigger output");

    const triggerResponse = await webhooks.replayInternalCallback(
      TRIGGER_PATH,
      trigger.deliveries[0]!,
    );
    expect(triggerResponse.status).toBe(200);
    await expect(triggerResponse.json()).resolves.toStrictEqual({
      success: true,
    });
    const triggerEmail = lastSentEmail();
    expect(triggerEmail).toMatchObject({
      from: `Zero <${fx.orgSlug}@mail.example.com>`,
      to: [fx.userEmail],
      subject: "Re: Legacy request",
      replyTo: `reply+${replyToken}@mail.example.com`,
    });
    expect(triggerEmail.html).toContain("legacy trigger output");
  });

  it("completes an already-running reply callback and updates its thread", async () => {
    const fx = await emailOrg();
    const threadSessionId = randomUUID();
    const replyToken = `retired-${randomUUID()}`;
    const inboundMessageId = "<reply-inbound@example.com>";
    const reply = await createLegacyEmailRun(fx, {
      prompt: "Legacy reply prompt",
      callbackPath: REPLY_PATH,
      callbackPayloads: [
        {
          emailThreadSessionId: threadSessionId,
          inboundEmailId: `email_${randomUUID()}`,
          inboundMessageId,
          inboundReferences: "<root@example.com>",
          replyRecipientTo: [fx.userEmail],
          replyRecipientCc: ["cc@example.com"],
        },
        {
          emailThreadSessionId: threadSessionId,
          inboundEmailId: `email_${randomUUID()}`,
          replyRecipientTo: [fx.userEmail],
          replyRecipientCc: [],
        },
      ],
    });
    // The retired endpoint cannot create an email thread anymore. Seed only
    // the persisted row that an already-running pre-shutdown reply references.
    await callbackStore.set(
      seedEmailThreadSession$,
      {
        threadSessionId,
        userId: fx.userId,
        agentId: fx.agentId,
        agentSessionId: reply.sessionId,
        replyToToken: replyToken,
        orgId: fx.orgId,
        lastEmailMessageId: "<previous-agent-reply@example.com>",
      },
      context.signal,
    );

    const threadedDelivery = reply.deliveries.find((delivery) => {
      return deliveryPayload(delivery).inboundMessageId === inboundMessageId;
    });
    const updatedThreadDelivery = reply.deliveries.find((delivery) => {
      return deliveryPayload(delivery).inboundMessageId === undefined;
    });
    if (!threadedDelivery || !updatedThreadDelivery) {
      throw new Error("Expected both legacy reply callback deliveries");
    }

    mockRunOutput("legacy reply output");
    const replyResponse = await webhooks.replayInternalCallback(
      REPLY_PATH,
      threadedDelivery,
    );
    expect(replyResponse.status).toBe(200);
    await expect(replyResponse.json()).resolves.toStrictEqual({
      success: true,
    });
    const replyEmail = lastSentEmail();
    expect(replyEmail).toMatchObject({
      from: `Zero <${fx.orgSlug}@mail.example.com>`,
      to: [fx.userEmail],
      cc: ["cc@example.com"],
      replyTo: `reply+${replyToken}@mail.example.com`,
      headers: {
        "In-Reply-To": inboundMessageId,
        References: `<root@example.com> ${inboundMessageId}`,
        "List-Unsubscribe": expect.any(String),
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    expect(replyEmail.html).toContain("legacy reply output");

    mockRunOutput("updated thread output");
    const updatedThreadResponse = await webhooks.replayInternalCallback(
      REPLY_PATH,
      updatedThreadDelivery,
    );
    expect(updatedThreadResponse.status).toBe(200);
    const updatedThreadEmail = lastSentEmail();
    expect(updatedThreadEmail.headers).toMatchObject({
      "In-Reply-To": "<sent@example.com>",
      References: "<sent@example.com>",
    });
    expect(updatedThreadEmail.html).toContain("updated thread output");
  });
});
