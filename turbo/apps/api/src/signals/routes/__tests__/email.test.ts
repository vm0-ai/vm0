import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import {
  deleteUsagePricingRows,
  seedUsagePricingRows,
} from "../../../test-fixtures/system-config-seeds";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createEmailApi } from "./helpers/api-bdd-email";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const resendMocks = context.mocks.resend;
const bdd = createBddApi(context);
const email = createEmailApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);

const INBOUND_SECRET = "whsec_test";

interface EmailOrgFixture {
  readonly userEmail: string;
  readonly orgSlug: string;
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
    userEmail: actor.email,
    orgSlug,
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

beforeEach(() => {
  resendMocks.send.mockReset();
  resendMocks.send.mockResolvedValue({ data: { id: "resend-test-id" } });
  mockEnv("RESEND_API_KEY", "test-resend-key");
  mockEnv("RESEND_WEBHOOK_SECRET", INBOUND_SECRET);
  mockEnv("RESEND_FROM_DOMAIN", "mail.example.com");
  mockEnv("OKOU_API_BACKEND_URL", "https://api.vm0.ai");
  // Resend pacing is not part of these transactional delivery assertions.
  mockOptionalEnv("EMAIL_OUTBOX_DRAIN_DELAY_MS", "0");
});

describe("low-credit email delivery", () => {
  it("uses the configured sender domain for low-credit alerts", async () => {
    const actor = bdd.user();
    const billing = createBillingMediaApi(context);
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    await runs.grantProEntitlement(actor);

    const before = await billing.readBillingStatus(actor);
    expect(before.credits).toBeGreaterThan(5000);
    const modelProvider = `bdd-low-credit-${randomUUID()}`;
    onTestFinished(async () => {
      await deleteUsagePricingRows({
        kind: "model",
        provider: modelProvider,
        categories: ["tokens.output"],
      });
    });
    await seedUsagePricingRows([
      {
        kind: "model",
        provider: modelProvider,
        category: "tokens.output",
        unitPrice: before.credits - 4999,
        unitSize: 1,
      },
    ]);

    const agentName = `bdd-low-credit-${randomUUID().slice(0, 8)}`;
    const compose = await runs.createDirectAgent(actor, {
      version: "1.0",
      agents: {
        [agentName]: {
          framework: "claude-code",
          environment: { ANTHROPIC_API_KEY: "bdd-inline-key" },
        },
      },
    });
    const run = await runs.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "cross the low-credit alert threshold",
      triggerSource: "web",
    });
    await webhooks.requestAgentUsageEvent(
      {
        runId: run.runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "model",
            provider: modelProvider,
            category: "tokens.output",
            quantity: 1,
          },
        ],
      },
      {
        authorization: `Bearer ${runs.sandboxTokenForRun(actor, run.runId)}`,
      },
      [200],
    );

    // Refresh the current Clerk membership mocks before settlement resolves
    // the organization's admin recipients.
    await billing.readBillingStatus(actor);
    await billing.processOrgUsageEvents(actor);
    const item = await email.findEmailOutboxItem({
      to: actor.email,
      subject: "Your credit balance is running low",
    });
    const drained = await email.drainEmailOutboxItems([item.id]);

    expect(drained).toBe(1);
    expect(resendMocks.send).toHaveBeenCalledTimes(1);
    expect(context.mocks.resend.send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "VM0 Team <support@mail.example.com>",
        to: actor.email,
        subject: "Your credit balance is running low",
      }),
    );
  });
});

describe("POST /api/email/inbound", () => {
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

    const locator = await email.enqueueDataExportEmail(controlActor);
    const item = await email.findEmailOutboxItem(locator);
    const drained = await email.drainEmailOutboxItems([item.id]);

    expect(drained).toBe(1);
    expect(resendMocks.send).toHaveBeenCalledTimes(1);
    expect(resendMocks.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: controlActor.email }),
    );
    const sent = resendMocks.send.mock.calls[0]?.[0];
    if (!sent) {
      throw new Error("Expected a data-export email");
    }
    if (
      typeof sent !== "object" ||
      sent === null ||
      !("headers" in sent) ||
      typeof sent.headers !== "object" ||
      sent.headers === null
    ) {
      throw new Error("Expected a one-click unsubscribe header");
    }
    const oneClickHeader = Reflect.get(sent.headers, "List-Unsubscribe");
    if (typeof oneClickHeader !== "string") {
      throw new Error("Expected a one-click unsubscribe header");
    }
    const oneClickUrl = new URL(oneClickHeader.slice(1, -1));
    expect(oneClickUrl.origin).toBe("https://api.vm0.ai");
    expect(oneClickUrl.pathname).toBe("/api/email/unsubscribe");
    expect(oneClickUrl.searchParams.get("token")).toBeTruthy();
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

    const locator = await email.enqueueDataExportEmail(bouncedActor);
    const item = await email.findEmailOutboxItem(locator);
    const drained = await email.drainEmailOutboxItems([item.id]);

    expect(drained).toBe(1);
    expect(resendMocks.send).toHaveBeenCalledTimes(0);
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

    const locator = await email.enqueueDataExportEmail(complainedActor);
    const items = await email.findEmailOutboxItems(locator);

    expect(items).toHaveLength(0);
    expect(resendMocks.send).toHaveBeenCalledTimes(0);
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
    expect(resendMocks.send).not.toHaveBeenCalled();
  });

  it("acknowledges unrelated signed Resend events without background work", async () => {
    const response = await postInbound({
      type: "email.sent",
      data: { email_id: "email_sent" },
    });

    expect(response.body).toStrictEqual({ received: true });
    await flushWaitUntilForTest();
    expect(resendMocks.send).not.toHaveBeenCalled();
  });
});
