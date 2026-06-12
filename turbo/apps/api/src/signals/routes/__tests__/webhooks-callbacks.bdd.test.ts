import { createHash, randomInt, randomUUID } from "node:crypto";

import { MAX_FILE_SIZE_BYTES } from "@vm0/api-contracts/contracts/storages";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { testContext } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settle } from "../../utils";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createGithubBddApi, newGithubUserId } from "./helpers/api-bdd-github";
import {
  createRunsAutomationsApi,
  uniqueAutomationName,
} from "./helpers/api-bdd-runs-automations";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const api = createWebhookCallbackApi(context);

function orgOf(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor");
  }
  return actor.orgId;
}

function epochSeconds(offsetDays: number): number {
  return Math.floor(now() / 1000) + offsetDays * 86_400;
}

function isoOf(epoch: number): string {
  return new Date(epoch * 1000).toISOString();
}

async function waitForExpectation(
  assertion: () => void | Promise<void>,
): Promise<void> {
  await expect
    .poll(async () => {
      const result = await settle(Promise.resolve().then(assertion));
      return result.ok;
    })
    .toBe(true);
}

function stripeEvent(args: {
  readonly type: string;
  readonly object: Record<string, unknown>;
  readonly previousAttributes?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: `evt_bdd_${randomUUID()}`,
    type: args.type,
    created: Math.floor(now() / 1000),
    data: {
      object: args.object,
      ...(args.previousAttributes === undefined
        ? {}
        : { previous_attributes: args.previousAttributes }),
    },
  };
}

function subscriptionLines(periodEndUnix: number): {
  readonly data: readonly {
    readonly period: { readonly end: number };
    readonly parent: { readonly type: "subscription_item_details" };
  }[];
} {
  return {
    data: [
      {
        period: { end: periodEndUnix },
        parent: { type: "subscription_item_details" },
      },
    ],
  };
}

function proSubscription(args: {
  readonly id: string;
  readonly customerId: string;
  readonly status?: string;
  readonly trialEnd?: number;
  readonly metadata?: Record<string, string>;
}): Record<string, unknown> {
  return {
    id: args.id,
    status: args.status ?? "active",
    customer: args.customerId,
    cancel_at: null,
    cancel_at_period_end: false,
    schedule: null,
    trial_end: args.trialEnd ?? null,
    metadata: args.metadata ?? {},
    items: { data: [{ price: { id: "price_bdd_pro" } }] },
  };
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function acceptGithubGrantRevocations(): void {
  server.use(
    http.delete("https://api.github.com/applications/:clientId/grant", () => {
      return new HttpResponse(null, { status: 204 });
    }),
  );
}

function acceptTelegramDomainProbes(): void {
  server.use(
    http.head("https://oauth.telegram.org/auth", () => {
      return new HttpResponse(null, {
        status: 200,
        headers: { "content-length": "2001" },
      });
    }),
  );
}

async function registerTelegramBot(
  actor: ApiTestUser,
  defaultAgentId: string,
): Promise<string> {
  const integrations = createBddIntegrationApi(context);
  const telegramBotId = randomInt(1_000_000_000, 9_999_999_999);
  const botToken = `${telegramBotId}:bdd-token-${randomUUID().slice(0, 8)}`;
  acceptTelegramDomainProbes();
  context.mocks.telegram.getMe.mockResolvedValue({
    id: telegramBotId,
    username: `bdd_bot_${telegramBotId}`,
    can_read_all_group_messages: true,
  });
  await integrations.requestRegisterTelegramBot(
    actor,
    { botToken, defaultAgentId },
    [201],
  );
  return botToken;
}

describe("WHCB-01: third-party webhook verification boundaries", () => {
  it("reports unconfigured third-party webhooks through public responses", async () => {
    api.disableStripeWebhookSecret();
    const stripe = await api.requestStripeWebhook(
      "{}",
      { "stripe-signature": "sig_bdd" },
      [503],
    );
    expect(stripe.body).toStrictEqual({
      error: "Stripe billing is not configured",
    });

    api.disableGithubWebhookSecret();
    const githubBody = "{}";
    const github = await api.requestGithubWebhook(
      githubBody,
      api.signedGithubWebhookHeaders(githubBody, "ping"),
      [503],
    );
    expect(github.body).toStrictEqual({
      error: "GitHub App integration is not configured",
    });
  });

  it("rejects Stripe requests with missing or invalid signatures", async () => {
    api.configureStripeWebhookSecret();

    const missingSignature = await api.requestStripeWebhook("{}", {}, [401]);
    expect(missingSignature.body).toStrictEqual({
      error: "Missing stripe-signature header",
    });

    api.rejectNextStripeWebhookSignature();
    const invalidSignature = await api.requestStripeWebhook(
      "{}",
      { "stripe-signature": "bad-signature" },
      [401],
    );
    expect(invalidSignature.body).toStrictEqual({
      error: "Invalid webhook signature",
    });

    api.acceptNextStripeWebhookEvent({
      id: `evt_bdd_${randomUUID()}`,
      type: "charge.succeeded",
      data: { object: { id: `ch_bdd_${randomUUID()}` } },
    });
    const ignored = await api.requestStripeWebhook(
      "{}",
      { "stripe-signature": "valid-signature" },
      [200],
    );
    expect(ignored.body).toBe("OK");
  });

  it("accepts signed Stripe events that do not require existing billing state", async () => {
    api.configureStripeWebhookSecret();

    api.acceptNextStripeWebhookEvent({
      id: `evt_bdd_${randomUUID()}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_bdd_${randomUUID()}`,
          invoice: `in_bdd_${randomUUID()}`,
          subscription: null,
          customer: null,
          metadata: { purpose: "credit_purchase" },
        },
      },
    });
    const creditPurchaseCheckout = await api.requestStripeWebhook(
      "{}",
      { "stripe-signature": "valid-signature" },
      [200],
    );
    expect(creditPurchaseCheckout.body).toBe("OK");

    api.acceptNextStripeWebhookEvent({
      id: `evt_bdd_${randomUUID()}`,
      type: "checkout.session.async_payment_succeeded",
      data: {
        object: {
          id: `cs_bdd_${randomUUID()}`,
          invoice: null,
          subscription: null,
          customer: null,
          metadata: { purpose: "one_time_purchase" },
          payment_status: "unpaid",
        },
      },
    });
    const unpaidOneTimeCheckout = await api.requestStripeWebhook(
      "{}",
      { "stripe-signature": "valid-signature" },
      [200],
    );
    expect(unpaidOneTimeCheckout.body).toBe("OK");

    api.acceptNextStripeWebhookEvent({
      id: `evt_bdd_${randomUUID()}`,
      type: "invoice.paid",
      data: {
        object: {
          id: `in_bdd_${randomUUID()}`,
          customer: null,
          metadata: null,
          subtotal: null,
          lines: { data: [] },
          parent: null,
        },
      },
    });
    const invoiceWithoutSubscription = await api.requestStripeWebhook(
      "{}",
      { "stripe-signature": "valid-signature" },
      [200],
    );
    expect(invoiceWithoutSubscription.body).toBe("OK");

    api.acceptNextStripeWebhookEvent({
      id: `evt_bdd_${randomUUID()}`,
      type: "customer.subscription.created",
      data: {
        object: {
          id: `sub_bdd_${randomUUID()}`,
          customer: null,
          status: "active",
          metadata: null,
          cancel_at_period_end: false,
          items: { data: [] },
        },
      },
    });
    const subscriptionCreatedWithoutCustomer = await api.requestStripeWebhook(
      "{}",
      { "stripe-signature": "valid-signature" },
      [200],
    );
    expect(subscriptionCreatedWithoutCustomer.body).toBe("OK");

    api.acceptNextStripeWebhookEvent({
      id: `evt_bdd_${randomUUID()}`,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: `sub_bdd_${randomUUID()}`,
          status: "active",
          metadata: null,
          cancel_at_period_end: false,
          items: { data: [] },
        },
        previous_attributes: { cancel_at_period_end: true },
      },
    });
    const subscriptionUpdatedWithoutOrg = await api.requestStripeWebhook(
      "{}",
      { "stripe-signature": "valid-signature" },
      [200],
    );
    expect(subscriptionUpdatedWithoutOrg.body).toBe("OK");

    api.acceptNextStripeWebhookEvent({
      id: `evt_bdd_${randomUUID()}`,
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: `sub_bdd_${randomUUID()}`,
          metadata: null,
        },
      },
    });
    const subscriptionDeletedWithoutOrg = await api.requestStripeWebhook(
      "{}",
      { "stripe-signature": "valid-signature" },
      [200],
    );
    expect(subscriptionDeletedWithoutOrg.body).toBe("OK");

    api.acceptNextStripeWebhookEvent({
      id: `evt_bdd_${randomUUID()}`,
      type: "subscription_schedule.released",
      data: { object: { id: `sched_bdd_${randomUUID()}` } },
    });
    const releasedScheduleWithoutOrg = await api.requestStripeWebhook(
      "{}",
      { "stripe-signature": "valid-signature" },
      [200],
    );
    expect(releasedScheduleWithoutOrg.body).toBe("OK");

    api.acceptNextStripeWebhookEvent({
      id: `evt_bdd_${randomUUID()}`,
      type: "subscription_schedule.canceled",
      data: { object: { id: `sched_bdd_${randomUUID()}` } },
    });
    const canceledScheduleWithoutOrg = await api.requestStripeWebhook(
      "{}",
      { "stripe-signature": "valid-signature" },
      [200],
    );
    expect(canceledScheduleWithoutOrg.body).toBe("OK");
  });

  it("rejects Clerk requests when webhook verification is missing or invalid", async () => {
    api.configureClerkWebhookSecret();

    api.rejectNextClerkWebhookVerification();
    const missingVerification = await api.requestClerkWebhook("{}", {}, [401]);
    expect(missingVerification.body).toStrictEqual({
      error: "Invalid webhook signature",
    });

    api.rejectNextClerkWebhookVerification();
    const invalidVerification = await api.requestClerkWebhook(
      "{}",
      {
        "svix-id": "msg_bdd",
        "svix-timestamp": "1700000000",
        "svix-signature": "v1,bad",
      },
      [401],
    );
    expect(invalidVerification.body).toStrictEqual({
      error: "Invalid webhook signature",
    });
  });

  it("accepts verified Clerk events that do not require visible cleanup", async () => {
    api.configureClerkWebhookSecret();

    api.verifyNextClerkWebhook({
      type: "session.created",
      data: { id: "sess_bdd" },
    });
    const ignored = await api.requestClerkWebhook("{}", {}, [200]);
    expect(ignored.body).toBe("OK");

    api.verifyNextClerkWebhook({
      type: "organization.deleted",
      data: {},
    });
    const missingOrgId = await api.requestClerkWebhook("{}", {}, [200]);
    expect(missingOrgId.body).toBe("OK");

    api.verifyNextClerkWebhook({
      type: "user.deleted",
      data: {},
    });
    const missingUserId = await api.requestClerkWebhook("{}", {}, [200]);
    expect(missingUserId.body).toBe("OK");

    api.verifyNextClerkWebhook({
      type: "organizationMembership.deleted",
      data: { id: "mem_bdd" },
    });
    const membershipDeleted = await api.requestClerkWebhook("{}", {}, [200]);
    expect(membershipDeleted.body).toBe("OK");
  });

  it("rejects GitHub requests with missing headers or invalid signatures", async () => {
    api.configureGithubWebhookSecret();

    const missingHeaders = await api.requestGithubWebhook("{}", {}, [401]);
    expect(missingHeaders.body).toStrictEqual({
      error: "Missing GitHub webhook headers",
    });

    const invalidSignature = await api.requestGithubWebhook(
      "{}",
      {
        "x-github-delivery": "delivery-bdd",
        "x-github-event": "ping",
        "x-hub-signature-256": "sha256=bad",
      },
      [401],
    );
    expect(invalidSignature.body).toStrictEqual({
      error: "Invalid signature",
    });

    const invalidJson = await api.requestGithubWebhook(
      "not-json",
      api.signedGithubWebhookHeaders("not-json", "ping"),
      [400],
    );
    expect(invalidJson.body).toStrictEqual({
      error: "Invalid JSON payload",
    });

    const pingBody = "{}";
    const ping = await api.requestGithubWebhook(
      pingBody,
      api.signedGithubWebhookHeaders(pingBody, "ping"),
      [200],
    );
    expect(ping.body).toStrictEqual({ message: "pong" });

    const ignoredBody = JSON.stringify({ action: "ignored" });
    const ignored = await api.requestGithubWebhook(
      ignoredBody,
      api.signedGithubWebhookHeaders(ignoredBody, "workflow_job"),
      [200],
    );
    expect(ignored.body).toBe("OK");

    const invalidIssuesBody = JSON.stringify({ action: "opened" });
    const invalidIssues = await api.requestGithubWebhook(
      invalidIssuesBody,
      api.signedGithubWebhookHeaders(invalidIssuesBody, "issues"),
      [400],
    );
    expect(invalidIssues.body).toStrictEqual({
      error: "Invalid payload structure",
    });

    const invalidPullRequestBody = JSON.stringify({ action: "opened" });
    const invalidPullRequest = await api.requestGithubWebhook(
      invalidPullRequestBody,
      api.signedGithubWebhookHeaders(invalidPullRequestBody, "pull_request"),
      [400],
    );
    expect(invalidPullRequest.body).toStrictEqual({
      error: "Invalid payload structure",
    });

    const invalidIssueCommentBody = JSON.stringify({ action: "created" });
    const invalidIssueComment = await api.requestGithubWebhook(
      invalidIssueCommentBody,
      api.signedGithubWebhookHeaders(invalidIssueCommentBody, "issue_comment"),
      [400],
    );
    expect(invalidIssueComment.body).toStrictEqual({
      error: "Invalid payload structure",
    });

    const invalidInstallationBody = JSON.stringify({ action: "created" });
    const invalidInstallation = await api.requestGithubWebhook(
      invalidInstallationBody,
      api.signedGithubWebhookHeaders(invalidInstallationBody, "installation"),
      [400],
    );
    expect(invalidInstallation.body).toStrictEqual({
      error: "Invalid payload structure",
    });
  });

  it("accepts signed GitHub events that do not dispatch work", async () => {
    api.configureGithubWebhookSecret();
    const user = { id: 42, login: "bdd-user", type: "User" };
    const bot = { id: 43, login: "zero[bot]", type: "Bot" };
    const repository = { full_name: "vm0-ai/vm0" };
    const installation = { id: 12_345 };
    const issue = {
      number: 123,
      title: "BDD issue",
      body: "No bot mention here.",
      labels: [],
      user,
    };

    const closedIssueBody = JSON.stringify({
      action: "closed",
      issue,
      repository,
      installation,
      sender: user,
    });
    const closedIssue = await api.requestGithubWebhook(
      closedIssueBody,
      api.signedGithubWebhookHeaders(closedIssueBody, "issues"),
      [200],
    );
    expect(closedIssue.body).toBe("OK");

    const synchronizedPullRequestBody = JSON.stringify({
      action: "synchronize",
      pull_request: issue,
      repository,
      installation,
      sender: user,
    });
    const synchronizedPullRequest = await api.requestGithubWebhook(
      synchronizedPullRequestBody,
      api.signedGithubWebhookHeaders(
        synchronizedPullRequestBody,
        "pull_request",
      ),
      [200],
    );
    expect(synchronizedPullRequest.body).toBe("OK");

    const editedCommentBody = JSON.stringify({
      action: "edited",
      issue,
      comment: { id: 456, body: "@Zero please help", user },
      repository,
      installation,
      sender: user,
    });
    const editedComment = await api.requestGithubWebhook(
      editedCommentBody,
      api.signedGithubWebhookHeaders(editedCommentBody, "issue_comment"),
      [200],
    );
    expect(editedComment.body).toBe("OK");

    const botCommentBody = JSON.stringify({
      action: "created",
      issue,
      comment: { id: 457, body: "@Zero please help", user: bot },
      repository,
      installation,
      sender: bot,
    });
    const botComment = await api.requestGithubWebhook(
      botCommentBody,
      api.signedGithubWebhookHeaders(botCommentBody, "issue_comment"),
      [200],
    );
    expect(botComment.body).toBe("OK");

    const unmentionedCommentBody = JSON.stringify({
      action: "created",
      issue,
      comment: { id: 458, body: "plain follow-up", user },
      repository,
      installation,
      sender: user,
    });
    const unmentionedComment = await api.requestGithubWebhook(
      unmentionedCommentBody,
      api.signedGithubWebhookHeaders(unmentionedCommentBody, "issue_comment"),
      [200],
    );
    expect(unmentionedComment.body).toBe("OK");

    const mentionedCommentWithoutInstallBody = JSON.stringify({
      action: "created",
      issue,
      comment: { id: 459, body: "@Zero please help", user },
      repository,
      installation,
      sender: user,
    });
    const mentionedCommentWithoutInstall = await api.requestGithubWebhook(
      mentionedCommentWithoutInstallBody,
      api.signedGithubWebhookHeaders(
        mentionedCommentWithoutInstallBody,
        "issue_comment",
      ),
      [200],
    );
    expect(mentionedCommentWithoutInstall.body).toBe("OK");

    const ignoredInstallationBody = JSON.stringify({
      action: "suspend",
      installation: {
        id: 67_890,
        account: { id: 98_765, login: "vm0-ai", type: "Organization" },
      },
      sender: { id: 42, login: "bdd-user" },
    });
    const ignoredInstallation = await api.requestGithubWebhook(
      ignoredInstallationBody,
      api.signedGithubWebhookHeaders(ignoredInstallationBody, "installation"),
      [200],
    );
    expect(ignoredInstallation.body).toBe("OK");

    const createdInstallationBody = JSON.stringify({
      action: "created",
      installation: {
        id: 67_891,
        account: { id: 98_765, login: "vm0-ai", type: "Organization" },
      },
      sender: { id: 42, login: "bdd-user" },
    });
    const createdInstallation = await api.requestGithubWebhook(
      createdInstallationBody,
      api.signedGithubWebhookHeaders(createdInstallationBody, "installation"),
      [200],
    );
    expect(createdInstallation.body).toBe("OK");

    const deletedInstallationBody = JSON.stringify({
      action: "deleted",
      installation: {
        id: 67_892,
        account: { id: 98_765, login: "vm0-ai", type: "Organization" },
      },
      sender: { id: 42, login: "bdd-user" },
    });
    const deletedInstallation = await api.requestGithubWebhook(
      deletedInstallationBody,
      api.signedGithubWebhookHeaders(deletedInstallationBody, "installation"),
      [200],
    );
    expect(deletedInstallation.body).toBe("OK");
  });
});

describe("WHCB-02: built-in generation callback boundaries", () => {
  it("rejects invalid provider tokens before reading generation state", async () => {
    const generationId = randomUUID();

    const response = await api.requestFalGenerationWebhook({
      generationId,
      token: "invalid-token",
      body: "{}",
      statuses: [401],
    });

    expect(response.body).toStrictEqual({ error: "Invalid token" });
  });

  it("rejects malformed provider payloads after a valid token", async () => {
    const generationId = randomUUID();

    const response = await api.requestBytePlusGenerationWebhook({
      generationId,
      token: api.bytePlusGenerationWebhookToken(generationId),
      body: "not-json",
      statuses: [400],
    });

    expect(response.body).toStrictEqual({ error: "Invalid payload" });
  });

  it("accepts valid provider callbacks that do not have an active generation job", async () => {
    const falGenerationId = randomUUID();
    const falVisualKey = "visual-bdd";

    const falResponse = await api.requestFalGenerationWebhook({
      generationId: falGenerationId,
      visualKey: falVisualKey,
      token: api.falGenerationWebhookToken(falGenerationId, falVisualKey),
      body: {
        status: "COMPLETED",
        payload: { images: [] },
      },
      statuses: [200],
    });
    expect(falResponse.body).toBe("OK");

    const falDataResponse = await api.requestFalGenerationWebhook({
      generationId: falGenerationId,
      visualKey: falVisualKey,
      token: api.falGenerationWebhookToken(falGenerationId, falVisualKey),
      body: {
        status: "COMPLETED",
        data: [{ url: "https://assets.example.test/image.png" }],
      },
      statuses: [200],
    });
    expect(falDataResponse.body).toBe("OK");

    const falNestedResponse = await api.requestFalGenerationWebhook({
      generationId: falGenerationId,
      visualKey: falVisualKey,
      token: api.falGenerationWebhookToken(falGenerationId, falVisualKey),
      body: {
        status: "COMPLETED",
        response: { images: [] },
      },
      statuses: [200],
    });
    expect(falNestedResponse.body).toBe("OK");

    const bytePlusGenerationId = randomUUID();
    const queuedResponse = await api.requestBytePlusGenerationWebhook({
      generationId: bytePlusGenerationId,
      token: api.bytePlusGenerationWebhookToken(bytePlusGenerationId),
      body: { status: "queued" },
      statuses: [200],
    });
    expect(queuedResponse.body).toBe("OK");

    const runningResponse = await api.requestBytePlusGenerationWebhook({
      generationId: bytePlusGenerationId,
      token: api.bytePlusGenerationWebhookToken(bytePlusGenerationId),
      body: { status: "running" },
      statuses: [200],
    });
    expect(runningResponse.body).toBe("OK");

    const completedResponse = await api.requestBytePlusGenerationWebhook({
      generationId: bytePlusGenerationId,
      token: api.bytePlusGenerationWebhookToken(bytePlusGenerationId),
      body: { status: "succeeded", content: { video: [] } },
      statuses: [200],
    });
    expect(completedResponse.body).toBe("OK");
  });
});

describe("WHCB-03: email inbound webhook boundaries", () => {
  it("keeps missing, invalid, and signed non-run Resend events visible through the inbound API", async () => {
    const missingHeaders = await api.requestResendInboundWebhook(
      { type: "email.received" },
      {},
      [401],
    );
    expect(missingHeaders.body).toStrictEqual({
      error: "Missing signature headers",
    });

    api.configureResendWebhookSecret();
    const signedBody = { type: "email.opened" };
    const invalidSignature = await api.requestResendInboundWebhook(
      signedBody,
      {
        ...api.signedResendWebhookHeaders(signedBody),
        "svix-signature": "v1,bad-signature",
      },
      [401],
    );
    expect(invalidSignature.body).toStrictEqual({
      error: "Invalid signature",
    });

    const ignoredEvent = await api.requestResendInboundWebhook(
      signedBody,
      api.signedResendWebhookHeaders(signedBody),
      [200],
    );
    expect(ignoredEvent.body).toStrictEqual({ received: true });

    const bounceBody = {
      type: "email.bounced",
      data: {
        email_id: `email_bdd_bounce_${randomUUID()}`,
        to: [`bounce-${randomUUID()}@example.test`],
      },
    };
    const bounceResponse = await api.requestResendInboundWebhook(
      bounceBody,
      api.signedResendWebhookHeaders(bounceBody),
      [200],
    );
    expect(bounceResponse.body).toStrictEqual({ received: true });

    context.mocks.clerk.users.getUserList.mockResolvedValue({ data: [] });
    const complaintBody = {
      type: "email.complained",
      data: {
        email_id: `email_bdd_complaint_${randomUUID()}`,
        to: [`complaint-${randomUUID()}@example.test`],
      },
    };
    const complaintResponse = await api.requestResendInboundWebhook(
      complaintBody,
      api.signedResendWebhookHeaders(complaintBody),
      [200],
    );
    expect(complaintResponse.body).toStrictEqual({ received: true });

    const malformedReceived = {
      type: "email.received",
      data: { email_id: "email_bdd_missing_sender" },
    };
    const malformedResponse = await api.requestResendInboundWebhook(
      malformedReceived,
      api.signedResendWebhookHeaders(malformedReceived),
      [200],
    );
    expect(malformedResponse.body).toStrictEqual({ received: true });

    api.disableResendApiKey();
    const unrecognizedOrgAddress = {
      type: "email.received",
      data: {
        email_id: `email_bdd_unrecognized_${randomUUID()}`,
        to: [`bad+alias-${randomUUID()}@example.test`],
        from: "sender@example.test",
        subject: "Unrecognized org",
      },
    };
    const unrecognizedOrgResponse = await api.requestResendInboundWebhook(
      unrecognizedOrgAddress,
      api.signedResendWebhookHeaders(unrecognizedOrgAddress),
      [200],
    );
    expect(unrecognizedOrgResponse.body).toStrictEqual({ received: true });

    const invalidReplyAddress = {
      type: "email.received",
      data: {
        email_id: `email_bdd_reply_${randomUUID()}`,
        to: [`reply+bad-token-${randomUUID()}@example.test`],
        from: "sender@example.test",
        subject: "Invalid reply",
      },
    };
    const invalidReplyResponse = await api.requestResendInboundWebhook(
      invalidReplyAddress,
      api.signedResendWebhookHeaders(invalidReplyAddress),
      [200],
    );
    expect(invalidReplyResponse.body).toStrictEqual({ received: true });
  });

  it("skips email trigger callbacks while outbound email is not configured", async () => {
    api.disableResendApiKey();

    const response = await api.requestEmailTriggerCallback(
      {
        runId: randomUUID(),
        status: "completed",
        payload: {
          senderEmail: "sender@example.test",
          agentId: randomUUID(),
          userId: `user_${randomUUID()}`,
          inboundEmailId: `email_${randomUUID()}`,
          replyToken: `reply_${randomUUID()}`,
        },
      },
      [200],
    );

    expect(response.body).toStrictEqual({ success: true, skipped: true });
  });
});

describe("WHCB-04: internal callback and event-consumer boundaries", () => {
  it("rejects malformed callback bodies before callback lookup", async () => {
    const invalidJson = await api.requestInvalidAgentCallbackBody(
      "not-json",
      [400],
    );
    expect(invalidJson.body).toStrictEqual({ error: "Invalid JSON body" });

    const missingRunId = await api.requestAgentCallback(
      { status: "completed", payload: {} },
      [400],
    );
    expect(missingRunId.body).toStrictEqual({ error: "Missing runId" });
  });

  it("rejects event consumers with missing auth or invalid bodies", async () => {
    const body = {
      runId: randomUUID(),
      events: [],
      context: {
        userId: "user_bdd_event_consumer",
        orgId: "org_bdd_event_consumer",
      },
    };

    const missingSignature = await api.requestChatAssistantEventConsumer(
      body,
      {},
      [401],
    );
    expect(missingSignature.body).toStrictEqual({
      error: "Missing X-VM0-Signature header",
    });

    const invalidBody = await api.requestInvalidChatAssistantEventConsumerBody(
      "not-json",
      api.signedEventConsumerHeaders("not-json"),
      [401],
    );
    expect(invalidBody.body).toStrictEqual({ error: "Invalid JSON body" });
  });

  it("rejects agent callbacks whose runId-fallback lookup finds no callback row", async () => {
    const missingCallback = await api.requestAgentCallback(
      { runId: randomUUID(), status: "completed", payload: {} },
      [404],
    );
    expect(missingCallback.body).toStrictEqual({ error: "Callback not found" });
  });

  it("ingests signed axiom event batches and surfaces axiom outages as 503", async () => {
    const body = {
      runId: "run_bdd_axiom",
      events: [
        { type: "assistant", sequenceNumber: 1, message: { content: [] } },
        { type: "tool_result", sequenceNumber: 2, result: "ok" },
      ],
      context: { userId: "user_bdd_axiom", orgId: "org_bdd_axiom" },
    };
    context.mocks.axiom.ingest.mockReturnValue(true);
    context.mocks.axiom.flush.mockResolvedValue(undefined);

    const ingested = await api.requestAxiomEventConsumer(
      body,
      api.signedEventConsumerHeaders(body),
      [200],
    );
    expect(ingested.body).toStrictEqual({ received: 2 });
    expect(context.mocks.axiom.ingest).toHaveBeenCalledWith(
      "agent-run-events",
      [
        {
          runId: "run_bdd_axiom",
          userId: "user_bdd_axiom",
          sequenceNumber: 1,
          eventType: "assistant",
          eventData: {
            type: "assistant",
            sequenceNumber: 1,
            message: { content: [] },
          },
        },
        {
          runId: "run_bdd_axiom",
          userId: "user_bdd_axiom",
          sequenceNumber: 2,
          eventType: "tool_result",
          eventData: { type: "tool_result", sequenceNumber: 2, result: "ok" },
        },
      ],
    );
    expect(context.mocks.axiom.flush).toHaveBeenCalledWith({
      throwOnError: true,
      client: "sessions",
    });

    context.mocks.axiom.ingest.mockReturnValueOnce(false);
    const unconfigured = await api.requestAxiomEventConsumer(
      body,
      api.signedEventConsumerHeaders(body),
      [503],
    );
    expect(unconfigured.body).toStrictEqual({
      error: "Axiom agent-run-events dataset is not configured",
    });

    context.mocks.axiom.flush.mockRejectedValueOnce(new Error("axiom down"));
    const flushFailed = await api.requestAxiomEventConsumer(
      body,
      api.signedEventConsumerHeaders(body),
      [503],
    );
    expect(flushFailed.body).toStrictEqual({
      error: "Axiom agent-run-events flush failed",
    });
  });
});

describe("WHCB-05: sandbox agent webhook boundaries", () => {
  it("rejects malformed, unauthenticated, mismatched, and missing-run sandbox reports", async () => {
    const runId = randomUUID();
    const mismatchedRunId = randomUUID();
    const headers = api.sandboxWebhookHeaders({ runId });
    const mismatchedHeaders = api.sandboxWebhookHeaders({
      runId,
      tokenRunId: mismatchedRunId,
    });

    const malformedHeartbeat = await api.requestAgentHeartbeatUnchecked(
      {},
      {},
      [400],
    );
    expectApiError(malformedHeartbeat.body);
    expect(malformedHeartbeat.body.error.code).toBe("BAD_REQUEST");

    const unauthenticatedHeartbeat = await api.requestAgentHeartbeat(
      { runId },
      {},
      [401],
    );
    expectApiError(unauthenticatedHeartbeat.body);
    expect(unauthenticatedHeartbeat.body.error.code).toBe("UNAUTHORIZED");

    const nonSandboxBearerHeartbeat = await api.requestAgentHeartbeat(
      { runId },
      { authorization: "Bearer not-a-sandbox-token" },
      [401],
    );
    expectApiError(nonSandboxBearerHeartbeat.body);
    expect(nonSandboxBearerHeartbeat.body.error.code).toBe("UNAUTHORIZED");

    const mismatchedTelemetry = await api.requestAgentTelemetry(
      {
        runId,
        systemLog: "runner booted",
        metrics: [
          {
            ts: nowDate().toISOString(),
            cpu: 1,
            mem_used: 2,
            mem_total: 4,
            disk_used: 8,
            disk_total: 16,
          },
        ],
      },
      mismatchedHeaders,
      [401],
    );
    expectApiError(mismatchedTelemetry.body);
    expect(mismatchedTelemetry.body.error.code).toBe("UNAUTHORIZED");

    const missingHeartbeatRun = await api.requestAgentHeartbeat(
      { runId },
      headers,
      [404],
    );
    expectApiError(missingHeartbeatRun.body);
    expect(missingHeartbeatRun.body.error.code).toBe("NOT_FOUND");

    const mismatchedUsageEvent = await api.requestAgentUsageEvent(
      {
        runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "connector",
            provider: "github",
            category: "api_request",
            quantity: 1,
          },
        ],
      },
      mismatchedHeaders,
      [401],
    );
    expectApiError(mismatchedUsageEvent.body);
    expect(mismatchedUsageEvent.body.error.code).toBe("UNAUTHORIZED");

    const malformedTelemetry = await api.requestAgentTelemetryUnchecked(
      {},
      headers,
      [400],
    );
    expectApiError(malformedTelemetry.body);
    expect(malformedTelemetry.body.error.code).toBe("BAD_REQUEST");

    const malformedUsageEvent = await api.requestAgentUsageEventUnchecked(
      {
        runId,
        events: [],
      },
      headers,
      [400],
    );
    expectApiError(malformedUsageEvent.body);
    expect(malformedUsageEvent.body.error.code).toBe("BAD_REQUEST");

    const missingUsageRun = await api.requestAgentUsageEvent(
      {
        runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "connector",
            provider: "github",
            category: "api_request",
            quantity: 1,
          },
        ],
      },
      headers,
      [404],
    );
    expectApiError(missingUsageRun.body);
    expect(missingUsageRun.body.error.code).toBe("NOT_FOUND");

    const malformedModelUsage =
      await api.requestAgentModelUsageObservationUnchecked(
        {
          runId,
          events: [
            {
              idempotencyKey: randomUUID(),
              model: "claude-sonnet-4-6",
              category: "tokens.input",
              quantity: 0,
            },
          ],
        },
        headers,
        [400],
      );
    expectApiError(malformedModelUsage.body);
    expect(malformedModelUsage.body.error.code).toBe("BAD_REQUEST");

    const missingModelUsageRun = await api.requestAgentModelUsageObservation(
      {
        runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            model: "claude-sonnet-4-6",
            category: "tokens.input",
            quantity: 1,
          },
        ],
      },
      headers,
      [404],
    );
    expectApiError(missingModelUsageRun.body);
    expect(missingModelUsageRun.body.error.code).toBe("NOT_FOUND");

    const missingTelemetryRun = await api.requestAgentTelemetry(
      {
        runId,
        networkLogs: [
          {
            timestamp: nowDate().toISOString(),
            host: "example.test",
            port: 443,
            method: "GET",
            url: "https://example.test/status",
            status: 200,
            latency_ms: 12,
            request_size: 5,
            response_size: 8,
          },
        ],
        sandboxOperations: [
          {
            ts: nowDate().toISOString(),
            action_type: "checkpoint",
            duration_ms: 3,
            success: true,
          },
        ],
      },
      headers,
      [404],
    );
    expectApiError(missingTelemetryRun.body);
    expect(missingTelemetryRun.body.error.code).toBe("NOT_FOUND");
  });
});

describe("WHCB-06: sandbox agent artifact webhook boundaries", () => {
  it("rejects malformed, mismatched, and missing-run sandbox artifact reports", async () => {
    const runId = randomUUID();
    const hash = "a".repeat(64);
    const headers = api.sandboxWebhookHeaders({ runId });
    const mismatchedHeaders = api.sandboxWebhookHeaders({
      runId,
      tokenRunId: randomUUID(),
    });

    const malformedEvents = await api.requestAgentEventsUnchecked(
      { runId, events: [] },
      headers,
      [400],
    );
    expectApiError(malformedEvents.body);
    expect(malformedEvents.body.error.code).toBe("BAD_REQUEST");

    const mismatchedEvents = await api.requestAgentEvents(
      {
        runId,
        events: [{ type: "system", sequenceNumber: 0 }],
      },
      mismatchedHeaders,
      [401],
    );
    expectApiError(mismatchedEvents.body);
    expect(mismatchedEvents.body.error.code).toBe("UNAUTHORIZED");

    const missingEventsRun = await api.requestAgentEvents(
      {
        runId,
        events: [{ type: "system", sequenceNumber: 0 }],
      },
      headers,
      [404],
    );
    expectApiError(missingEventsRun.body);
    expect(missingEventsRun.body.error.code).toBe("NOT_FOUND");

    const malformedComplete = await api.requestAgentCompleteUnchecked(
      { runId },
      headers,
      [400],
    );
    expectApiError(malformedComplete.body);
    expect(malformedComplete.body.error.code).toBe("BAD_REQUEST");

    const mismatchedComplete = await api.requestAgentComplete(
      { runId, exitCode: 0, lastEventSequence: 0 },
      mismatchedHeaders,
      [401],
    );
    expectApiError(mismatchedComplete.body);
    expect(mismatchedComplete.body.error.code).toBe("UNAUTHORIZED");

    const missingCompleteRun = await api.requestAgentComplete(
      {
        runId,
        exitCode: 0,
        lastEventSequence: 0,
        sandboxId: "sandbox-bdd",
        sandboxReuseResult: "poolMiss",
      },
      headers,
      [404],
    );
    expectApiError(missingCompleteRun.body);
    expect(missingCompleteRun.body.error.code).toBe("NOT_FOUND");

    const malformedCheckpoint = await api.requestAgentCheckpointUnchecked(
      {
        runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: "session-bdd",
        cliAgentSessionHistoryHash: "not-a-sha",
      },
      headers,
      [400],
    );
    expectApiError(malformedCheckpoint.body);
    expect(malformedCheckpoint.body.error.code).toBe("BAD_REQUEST");

    const missingCheckpointRun = await api.requestAgentCheckpoint(
      {
        runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: "session-bdd",
        cliAgentSessionHistoryHash: hash,
      },
      headers,
      [404],
    );
    expectApiError(missingCheckpointRun.body);
    expect(missingCheckpointRun.body.error.code).toBe("NOT_FOUND");

    const mismatchedCheckpoint = await api.requestAgentCheckpoint(
      {
        runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: "session-bdd",
        cliAgentSessionHistoryHash: hash,
      },
      mismatchedHeaders,
      [401],
    );
    expectApiError(mismatchedCheckpoint.body);
    expect(mismatchedCheckpoint.body.error.code).toBe("UNAUTHORIZED");

    const mismatchedHistoryPrepare =
      await api.requestAgentCheckpointPrepareHistory(
        { runId, hash, size: 128 },
        mismatchedHeaders,
        [401],
      );
    expectApiError(mismatchedHistoryPrepare.body);
    expect(mismatchedHistoryPrepare.body.error.code).toBe("UNAUTHORIZED");

    const malformedHistoryPrepare =
      await api.requestAgentCheckpointPrepareHistoryUnchecked(
        { runId, hash, size: 0 },
        headers,
        [400],
      );
    expectApiError(malformedHistoryPrepare.body);
    expect(malformedHistoryPrepare.body.error.code).toBe("BAD_REQUEST");

    const mismatchedStoragePrepare = await api.requestAgentStoragePrepare(
      {
        runId,
        storageName: "artifact-bdd",
        storageType: "artifact",
        files: [{ path: "index.txt", hash, size: 5 }],
      },
      mismatchedHeaders,
      [401],
    );
    expectApiError(mismatchedStoragePrepare.body);
    expect(mismatchedStoragePrepare.body.error.code).toBe("UNAUTHORIZED");

    const malformedStoragePrepare =
      await api.requestAgentStoragePrepareUnchecked(
        {
          runId,
          storageName: "",
          storageType: "artifact",
          files: [{ path: "index.txt", hash, size: 5 }],
        },
        headers,
        [400],
      );
    expectApiError(malformedStoragePrepare.body);
    expect(malformedStoragePrepare.body.error.code).toBe("BAD_REQUEST");

    const mismatchedStorageCommit = await api.requestAgentStorageCommit(
      {
        runId,
        storageName: "artifact-bdd",
        storageType: "artifact",
        versionId: randomUUID(),
        files: [{ path: "index.txt", hash, size: 5 }],
      },
      mismatchedHeaders,
      [401],
    );
    expectApiError(mismatchedStorageCommit.body);
    expect(mismatchedStorageCommit.body.error.code).toBe("UNAUTHORIZED");

    const malformedStorageCommit = await api.requestAgentStorageCommitUnchecked(
      {
        runId,
        storageName: "artifact-bdd",
        storageType: "artifact",
        versionId: "",
        files: [{ path: "index.txt", hash, size: 5 }],
      },
      headers,
      [400],
    );
    expectApiError(malformedStorageCommit.body);
    expect(malformedStorageCommit.body.error.code).toBe("BAD_REQUEST");
  });
});

describe("WHCB-09: sandbox storage writes and checkpoint history blobs land in the run organization", () => {
  it("prepares, commits, dedups, and bounds sandbox storage writes for the run org", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsAutomationsApi(context);
    const storages = createStoragesBddApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD sandbox storage agent",
      visibility: "private",
    });
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "write artifacts from the sandbox",
      modelProvider: "anthropic-api-key",
    });
    const headers = {
      authorization: `Bearer ${runs.sandboxTokenForRun(actor, run.runId)}`,
    };

    // Checkpoint history blobs: first prepare issues an upload URL, the
    // second sees the registered blob and skips the upload.
    const historyHash = createHash("sha256")
      .update(`bdd history blob ${run.runId}`)
      .digest("hex");
    const firstHistory = await api.requestAgentCheckpointPrepareHistory(
      { runId: run.runId, hash: historyHash, size: 456 },
      headers,
      [200],
    );
    if (firstHistory.status !== 200) {
      throw new Error("Expected the first history prepare to succeed");
    }
    expect(firstHistory.body.existing).toBeFalsy();
    expect(firstHistory.body.presignedUrl).toMatch(/^https/);

    const repeatedHistory = await api.requestAgentCheckpointPrepareHistory(
      { runId: run.runId, hash: historyHash, size: 456 },
      headers,
      [200],
    );
    if (repeatedHistory.status !== 200) {
      throw new Error("Expected the repeated history prepare to succeed");
    }
    expect(repeatedHistory.body).toStrictEqual({ existing: true });

    const ghostRunId = randomUUID();
    const missingHistoryRun = await api.requestAgentCheckpointPrepareHistory(
      { runId: ghostRunId, hash: historyHash, size: 456 },
      {
        authorization: `Bearer ${runs.sandboxTokenForRun(actor, ghostRunId)}`,
      },
      [404],
    );
    expectApiError(missingHistoryRun.body);
    expect(missingHistoryRun.body.error.message).toBe("Agent run not found");

    // Artifact writes land under the run organization's storage prefix.
    const storageName = `bdd-sandbox-artifact-${randomUUID().slice(0, 8)}`;
    const files = [
      {
        path: "index.html",
        hash: createHash("sha256")
          .update(`bdd artifact ${storageName}`)
          .digest("hex"),
        size: 2048,
      },
    ];
    const prepared = await api.requestAgentStoragePrepare(
      { runId: run.runId, storageName, storageType: "artifact", files },
      headers,
      [200],
    );
    if (prepared.status !== 200) {
      throw new Error("Expected the sandbox storage prepare to succeed");
    }
    expect(prepared.body.existing).toBeFalsy();
    expect(prepared.body.uploads?.archive.key).toBe(
      `${orgOf(actor)}/artifact/${storageName}/${prepared.body.versionId}/archive.tar.gz`,
    );
    expect(prepared.body.uploads?.archive.presignedUrl).toMatch(/^https/);
    expect(prepared.body.uploads?.manifest.presignedUrl).toMatch(/^https/);

    const committed = await api.requestAgentStorageCommit(
      {
        runId: run.runId,
        storageName,
        storageType: "artifact",
        versionId: prepared.body.versionId,
        parentVersionId: "b".repeat(64),
        files,
        message: "bdd sandbox commit",
      },
      headers,
      [200],
    );
    if (committed.status !== 200) {
      throw new Error("Expected the sandbox storage commit to succeed");
    }
    expect(committed.body).toStrictEqual({
      success: true,
      versionId: prepared.body.versionId,
      storageName,
      size: 2048,
      fileCount: 1,
    });

    // Re-preparing identical content reuses the committed version without
    // new upload URLs.
    const reprepared = await api.requestAgentStoragePrepare(
      { runId: run.runId, storageName, storageType: "artifact", files },
      headers,
      [200],
    );
    if (reprepared.status !== 200) {
      throw new Error("Expected the duplicate prepare to succeed");
    }
    expect(reprepared.body).toStrictEqual({
      versionId: prepared.body.versionId,
      existing: true,
    });

    const mismatchedCommit = await api.requestAgentStorageCommit(
      {
        runId: run.runId,
        storageName,
        storageType: "artifact",
        versionId: "f".repeat(64),
        files,
      },
      headers,
      [400],
    );
    expectApiError(mismatchedCommit.body);
    expect(mismatchedCommit.body.error.message).toBe(
      "Version ID mismatch - files may have changed",
    );

    const oversized = await api.requestAgentStoragePrepare(
      {
        runId: run.runId,
        storageName: `bdd-oversized-${randomUUID().slice(0, 8)}`,
        storageType: "artifact",
        files: [
          {
            path: "a.bin",
            hash: "1".repeat(64),
            size: MAX_FILE_SIZE_BYTES,
          },
          { path: "b.bin", hash: "2".repeat(64), size: 1 },
        ],
      },
      headers,
      [413],
    );
    expectApiError(oversized.body);
    expect(oversized.body.error.code).toBe("PAYLOAD_TOO_LARGE");

    // The committed artifact is visible to the run owner through the public
    // storage reads.
    const listed = await storages.listStorages(actor, "artifact");
    expect(listed).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: storageName,
          size: 2048,
          fileCount: 1,
        }),
      ]),
    );
    const downloaded = await storages.downloadStorage(actor, {
      name: storageName,
      type: "artifact",
    });
    expect(downloaded).toMatchObject({
      versionId: prepared.body.versionId,
      size: 2048,
      fileCount: 1,
    });

    await runs.requestCancelRun(actor, run.runId, [200]);
    const cancelled = await runs.readRun(actor, run.runId);
    expect(cancelled.status).toBe("cancelled");
  });
});

describe("WHCB-07: Stripe billing lifecycle webhooks", () => {
  it("replays, expires, and auto-recharges subscription invoice credits", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsAutomationsApi(context);
    const billing = createBillingMediaApi(context);
    const actor = bdd.user();
    const orgId = orgOf(actor);
    const granted = await runs.grantProEntitlement(actor);

    const baseline = await billing.readBillingStatus(actor);
    expect(baseline.tier).toBe("pro");
    expect(baseline.credits).toBe(20_000);
    expect(baseline.creditGrants).toHaveLength(1);

    // Redelivering the processed entitlement invoice grants nothing more.
    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: granted.invoiceId,
          customer: granted.customerId,
          metadata: {},
          parent: {
            subscription_details: { subscription: granted.subscriptionId },
          },
          lines: subscriptionLines(epochSeconds(30)),
        },
      }),
      [200],
    );
    const afterReplay = await billing.readBillingStatus(actor);
    expect(afterReplay.credits).toBe(20_000);
    expect(afterReplay.creditGrants).toHaveLength(1);

    // An invoice whose subscription period already ended grants credits that
    // immediately count as expired-but-unsettled.
    const staleEpoch = epochSeconds(-60);
    const staleInvoiceId = `in_bdd_stale_${randomUUID().slice(0, 8)}`;
    const staleInvoice = {
      id: staleInvoiceId,
      customer: granted.customerId,
      metadata: {},
      parent: {
        subscription_details: { subscription: granted.subscriptionId },
      },
      lines: subscriptionLines(staleEpoch),
    };
    await api.postStripeEvent(
      stripeEvent({ type: "invoice.paid", object: staleInvoice }),
      [200],
    );
    const afterStale = await billing.readBillingStatus(actor);
    expect(afterStale.credits).toBe(20_000);
    expect(afterStale.creditGrants).toHaveLength(1);
    expect(afterStale.currentPeriodEnd).toBe(isoOf(staleEpoch));

    // The next renewal settles the expired grant before granting again.
    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_renewal_${randomUUID().slice(0, 8)}`,
          customer: granted.customerId,
          metadata: {},
          parent: {
            subscription_details: { subscription: granted.subscriptionId },
          },
          lines: subscriptionLines(epochSeconds(30)),
        },
      }),
      [200],
    );
    const afterRenewal = await billing.readBillingStatus(actor);
    expect(afterRenewal.credits).toBe(40_000);
    expect(afterRenewal.creditGrants).toHaveLength(2);

    // Concurrent duplicate deliveries of one invoice grant exactly once.
    const concurrentInvoice = {
      id: `in_bdd_concurrent_${randomUUID().slice(0, 8)}`,
      customer: granted.customerId,
      metadata: {},
      parent: {
        subscription_details: { subscription: granted.subscriptionId },
      },
      lines: subscriptionLines(epochSeconds(45)),
    };
    await Promise.all([
      api.postStripeEvent(
        stripeEvent({ type: "invoice.paid", object: concurrentInvoice }),
        [200],
      ),
      api.postStripeEvent(
        stripeEvent({ type: "invoice.paid", object: concurrentInvoice }),
        [200],
      ),
    ]);
    const afterConcurrent = await billing.readBillingStatus(actor);
    expect(afterConcurrent.credits).toBe(60_000);
    expect(afterConcurrent.creditGrants).toHaveLength(3);

    // A stale invoice redelivered after later renewals hits the existing
    // expires record and grants nothing.
    await api.postStripeEvent(
      stripeEvent({ type: "invoice.paid", object: staleInvoice }),
      [200],
    );
    expect((await billing.readBillingStatus(actor)).credits).toBe(60_000);

    // Invoices without a subscription line period fail loudly and roll back.
    const broken = await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_broken_${randomUUID().slice(0, 8)}`,
          customer: granted.customerId,
          metadata: {},
          parent: {
            subscription_details: { subscription: granted.subscriptionId },
          },
          lines: { data: [] },
        },
      }),
      [500],
    );
    expect(broken.body).toStrictEqual({ error: "Internal server error" });
    expect((await billing.readBillingStatus(actor)).credits).toBe(60_000);

    // Concurrent auto-recharge invoices grant the sentinel exactly once.
    const autoRechargeInvoice = {
      id: `in_bdd_auto_${randomUUID().slice(0, 8)}`,
      customer: granted.customerId,
      metadata: {
        type: "auto_recharge",
        orgId,
        creditsAmount: "5000",
      },
      parent: null,
    };
    await Promise.all([
      api.postStripeEvent(
        stripeEvent({ type: "invoice.paid", object: autoRechargeInvoice }),
        [200],
      ),
      api.postStripeEvent(
        stripeEvent({ type: "invoice.paid", object: autoRechargeInvoice }),
        [200],
      ),
    ]);
    const final = await billing.readBillingStatus(actor);
    expect(final.credits).toBe(65_000);
    const autoGrant = final.creditGrants.find((grant) => {
      return grant.source === "auto_recharge";
    });
    expect(autoGrant?.amount).toBe(5000);
    expect(autoGrant?.remaining).toBe(5000);
    expect(
      new Date(autoGrant?.expiresAt ?? "1970-01-01").getUTCFullYear(),
    ).toBeGreaterThanOrEqual(2999);
  });

  it("grants, refreshes, and clamps trial credits from trial-period invoices", async () => {
    const bdd = createBddApi(context);
    const billing = createBillingMediaApi(context);
    const actor = bdd.user();
    const orgId = orgOf(actor);
    api.configureStripeBillingEnv();
    await bdd.setupOnboarding(actor, { displayName: "BDD Trial Agent" });

    const suffix = randomUUID().slice(0, 8);
    const customerId = `cus_bdd_trial_${suffix}`;
    const subscriptionId = `sub_bdd_trial_${suffix}`;
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: { orgId },
    });

    // The first trial invoice arrives before any binding: the customer is
    // bound from its metadata and trial credits expire at the trial end.
    const trialEnd1 = epochSeconds(7);
    const periodEnd1 = epochSeconds(30);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      proSubscription({
        id: subscriptionId,
        customerId,
        status: "trialing",
        trialEnd: trialEnd1,
      }),
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_trial1_${suffix}`,
          customer: customerId,
          metadata: {},
          parent: { subscription_details: { subscription: subscriptionId } },
          lines: subscriptionLines(periodEnd1),
        },
      }),
      [200],
    );
    const grantedStatus = await billing.readBillingStatus(actor);
    expect(grantedStatus.tier).toBe("pro");
    expect(grantedStatus.credits).toBe(20_000);
    expect(grantedStatus.subscriptionStatus).toBe("trialing");
    expect(grantedStatus.currentPeriodEnd).toBe(isoOf(periodEnd1));
    expect(grantedStatus.creditExpiry.nextExpiryDate).toBe(isoOf(trialEnd1));

    // A later trial invoice refreshes the expiry without granting again.
    const trialEnd2 = epochSeconds(14);
    const periodEnd2 = epochSeconds(60);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      proSubscription({
        id: subscriptionId,
        customerId,
        status: "trialing",
        trialEnd: trialEnd2,
      }),
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_trial2_${suffix}`,
          customer: customerId,
          metadata: {},
          parent: { subscription_details: { subscription: subscriptionId } },
          lines: subscriptionLines(periodEnd2),
        },
      }),
      [200],
    );
    const refreshed = await billing.readBillingStatus(actor);
    expect(refreshed.credits).toBe(20_000);
    expect(refreshed.creditGrants).toHaveLength(1);
    expect(refreshed.currentPeriodEnd).toBe(isoOf(periodEnd2));
    expect(refreshed.creditExpiry.nextExpiryDate).toBe(isoOf(trialEnd2));

    // Shortening the trial clamps the paid-through date and credit expiry.
    const trialEnd3 = epochSeconds(10);
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.updated",
        object: {
          id: subscriptionId,
          status: "trialing",
          trial_end: trialEnd3,
          cancel_at_period_end: false,
          metadata: {},
          items: {
            data: [
              { price: { id: "price_bdd_pro" }, current_period_end: trialEnd3 },
            ],
          },
        },
        previousAttributes: { trial_end: trialEnd2 },
      }),
      [200],
    );
    const clamped = await billing.readBillingStatus(actor);
    expect(clamped.credits).toBe(20_000);
    expect(clamped.currentPeriodEnd).toBe(isoOf(trialEnd3));
    expect(clamped.creditExpiry.nextExpiryDate).toBe(isoOf(trialEnd3));

    // A trialing checkout completion binds the customer without re-granting.
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      proSubscription({
        id: subscriptionId,
        customerId,
        status: "trialing",
        trialEnd: trialEnd3,
        metadata: { gclid: "bdd-trial-gclid" },
      }),
    );
    const trialSessionId = `cs_bdd_trial_${suffix}`;
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: trialSessionId,
          subscription: subscriptionId,
          customer: customerId,
          metadata: null,
        },
      }),
      [200],
    );
    const afterTrialCheckout = await billing.readBillingStatus(actor);
    expect(afterTrialCheckout.credits).toBe(20_000);
  });

  it("upgrades to team, drains the queue, and cancels the replaced pro subscription", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsAutomationsApi(context);
    const billing = createBillingMediaApi(context);
    const actor = bdd.user();
    const orgId = orgOf(actor);
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    const granted = await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Team Upgrade Agent",
      visibility: "private",
    });

    const first = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "team upgrade run one",
      modelProvider: "anthropic-api-key",
    });
    const second = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "team upgrade run two",
      modelProvider: "anthropic-api-key",
    });
    const third = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "team upgrade run three",
      modelProvider: "anthropic-api-key",
    });
    expect(third.status).toBe("queued");
    const queuedBefore = await runs.readRunQueue(actor);
    expect(queuedBefore.body.concurrency.active).toBe(2);
    expect(queuedBefore.body.queue).toHaveLength(1);

    const suffix = randomUUID().slice(0, 8);
    const teamSubscriptionId = `sub_bdd_team_${suffix}`;
    const teamInvoiceId = `in_bdd_team_${suffix}`;
    const teamSubscription = {
      id: teamSubscriptionId,
      status: "active",
      customer: granted.customerId,
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      trial_end: null,
      metadata: {},
      items: { data: [{ price: { id: "price_bdd_team" } }] },
    };
    context.mocks.stripe.subscriptions.retrieve
      .mockResolvedValueOnce(teamSubscription)
      .mockResolvedValueOnce(teamSubscription);
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [
        {
          id: teamSubscriptionId,
          status: "active",
          metadata: { orgId },
          items: { data: [{ price: { id: "price_bdd_team" } }] },
        },
        {
          id: granted.subscriptionId,
          status: "active",
          metadata: { orgId },
          items: { data: [{ price: { id: "price_bdd_pro" } }] },
        },
      ],
    });
    context.mocks.stripe.subscriptions.cancel.mockResolvedValue({
      id: granted.subscriptionId,
    });

    const teamInvoice = {
      id: teamInvoiceId,
      customer: granted.customerId,
      metadata: {},
      parent: { subscription_details: { subscription: teamSubscriptionId } },
      lines: subscriptionLines(epochSeconds(30)),
    };
    await Promise.all([
      api.postStripeEvent(
        stripeEvent({ type: "invoice.paid", object: teamInvoice }),
        [200],
      ),
      api.postStripeEvent(
        stripeEvent({ type: "invoice.paid", object: teamInvoice }),
        [200],
      ),
    ]);

    expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledWith(
      granted.subscriptionId,
      { invoice_now: false, prorate: false },
    );
    const upgraded = await billing.readBillingStatus(actor);
    expect(upgraded.tier).toBe("team");
    expect(upgraded.credits).toBe(140_000);
    expect(
      upgraded.creditGrants.filter((grant) => {
        return grant.amount === 120_000;
      }),
    ).toHaveLength(1);

    const drained = await runs.readRunQueue(actor);
    expect(drained.body.concurrency.tier).toBe("team");
    expect(drained.body.queue).toHaveLength(0);
    expect(drained.body.concurrency.active).toBe(3);

    // Redelivering the processed team invoice re-runs lingering-pro cleanup.
    const cancelCallsBefore =
      context.mocks.stripe.subscriptions.cancel.mock.calls.length;
    await api.postStripeEvent(
      stripeEvent({ type: "invoice.paid", object: teamInvoice }),
      [200],
    );
    expect(
      context.mocks.stripe.subscriptions.cancel.mock.calls.length,
    ).toBeGreaterThan(cancelCallsBefore);
    expect((await billing.readBillingStatus(actor)).credits).toBe(140_000);

    // A lower-tier subscription invoice cannot replace the team subscription.
    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_lower_${suffix}`,
          customer: granted.customerId,
          metadata: {},
          parent: {
            subscription_details: {
              subscription: `sub_bdd_lower_${suffix}`,
            },
          },
          lines: subscriptionLines(epochSeconds(30)),
        },
      }),
      [200],
    );
    const unchanged = await billing.readBillingStatus(actor);
    expect(unchanged.tier).toBe("team");
    expect(unchanged.credits).toBe(140_000);

    // A downgrade-purpose setup checkout on the team org schedules the
    // period-end downgrade to pro through a new subscription schedule.
    const downgradeScheduleId = `sched_bdd_downgrade_${suffix}`;
    const phaseStart = epochSeconds(0);
    const phaseEnd = epochSeconds(30);
    const discountId = `di_bdd_${suffix}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: teamSubscriptionId,
      status: "active",
      customer: granted.customerId,
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      trial_end: null,
      metadata: {},
      discounts: [discountId],
      items: {
        data: [
          {
            id: `si_bdd_team_${suffix}`,
            current_period_start: phaseStart,
            current_period_end: phaseEnd,
            quantity: 1,
            price: {
              id: "price_bdd_team",
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    });
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
      id: downgradeScheduleId,
      current_phase: { start_date: phaseStart, end_date: phaseEnd },
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValueOnce({
      id: downgradeScheduleId,
    });
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: `cs_bdd_team_downgrade_${suffix}`,
          mode: "setup",
          subscription: null,
          customer: granted.customerId,
          setup_intent: {
            id: `seti_bdd_team_${suffix}`,
            payment_method: "pm_bdd_team_downgrade",
          },
          metadata: {
            purpose: "billing_downgrade",
            orgId,
            subscriptionId: teamSubscriptionId,
            targetTier: "pro",
          },
        },
      }),
      [200],
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).toHaveBeenCalledWith({ from_subscription: teamSubscriptionId });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(downgradeScheduleId, {
      end_behavior: "release",
      proration_behavior: "none",
      phases: [
        {
          start_date: phaseStart,
          end_date: phaseEnd,
          items: [{ price: "price_bdd_team", quantity: 1 }],
          proration_behavior: "none",
          discounts: [{ discount: discountId }],
        },
        {
          start_date: phaseEnd,
          duration: { interval: "month", interval_count: 1 },
          items: [{ price: "price_bdd_pro", quantity: 1 }],
          proration_behavior: "none",
          discounts: [{ discount: discountId }],
        },
      ],
    });
    const downgradeScheduled = await billing.readBillingStatus(actor);
    expect(downgradeScheduled.cancelAtPeriodEnd).toBeFalsy();
    expect(downgradeScheduled.scheduledChange).toStrictEqual({
      type: "downgrade",
      targetTier: "pro",
      effectiveDate: isoOf(phaseEnd),
    });

    // Deleting the team subscription suspends the organization.
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.deleted",
        object: { id: teamSubscriptionId, metadata: {} },
      }),
      [200],
    );
    const suspended = await billing.readBillingStatus(actor);
    expect(suspended.tier).toBe("pro-suspend");
    expect(suspended.subscriptionStatus).toBe("canceled");
    expect(suspended.hasSubscription).toBeFalsy();
    expect(suspended.scheduledChange).toBeNull();

    await runs.requestCancelRun(actor, first.runId, [200]);
    await runs.requestCancelRun(actor, second.runId, [200]);
    await runs.requestCancelRun(actor, third.runId, [200]);
    const settled = await runs.readRunQueue(actor);
    expect(settled.body.concurrency.active).toBe(0);
  });

  it("binds checkout and dashboard subscriptions to orgs without double-binding", async () => {
    const bdd = createBddApi(context);
    const billing = createBillingMediaApi(context);
    const actor = bdd.user();
    const orgId = orgOf(actor);
    api.configureStripeBillingEnv();
    await bdd.setupOnboarding(actor, { displayName: "BDD Binding Agent" });

    const suffix = randomUUID().slice(0, 8);
    const customerId = `cus_bdd_bind_${suffix}`;

    // A dashboard-created subscription binds the customer from its metadata.
    context.mocks.stripe.customers.retrieve.mockResolvedValueOnce({
      id: customerId,
      metadata: { orgId },
    });
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.created",
        object: {
          id: `sub_bdd_dash_${suffix}`,
          customer: customerId,
          status: "active",
          metadata: {},
          cancel_at_period_end: false,
          items: {
            data: [
              {
                price: { id: "price_bdd_pro" },
                current_period_end: epochSeconds(30),
              },
            ],
          },
        },
      }),
      [200],
    );
    const bound = await billing.readBillingStatus(actor);
    expect(bound.hasSubscription).toBeTruthy();
    expect(bound.subscriptionStatus).toBe("active");
    expect(bound.tier).toBe("pro-suspend");
    expect(bound.currentPeriodEnd).toBeNull();

    // An incomplete dashboard subscription is recorded without a paid tier.
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.created",
        object: {
          id: `sub_bdd_incomplete_${suffix}`,
          customer: customerId,
          status: "incomplete",
          metadata: {},
          cancel_at_period_end: false,
          items: { data: [{ price: { id: "price_bdd_pro" } }] },
        },
      }),
      [200],
    );
    const incomplete = await billing.readBillingStatus(actor);
    expect(incomplete.subscriptionStatus).toBe("incomplete");
    expect(incomplete.tier).toBe("pro-suspend");

    // A subscription checkout completion binds its subscription.
    const checkoutSubscriptionId = `sub_bdd_checkout_${suffix}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      proSubscription({ id: checkoutSubscriptionId, customerId }),
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: `cs_bdd_bind_${suffix}`,
          subscription: checkoutSubscriptionId,
          customer: customerId,
          metadata: null,
        },
      }),
      [200],
    );
    expect((await billing.readBillingStatus(actor)).subscriptionStatus).toBe(
      "active",
    );

    // Redelivering the checkout for the stored subscription is idempotent.
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      proSubscription({ id: checkoutSubscriptionId, customerId }),
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: `cs_bdd_bind_redelivery_${suffix}`,
          subscription: checkoutSubscriptionId,
          customer: customerId,
          metadata: null,
        },
      }),
      [200],
    );
    expect((await billing.readBillingStatus(actor)).subscriptionStatus).toBe(
      "active",
    );

    // A paid invoice grants the pro entitlement on the bound subscription.
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      proSubscription({ id: checkoutSubscriptionId, customerId }),
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_bind_${suffix}`,
          customer: customerId,
          metadata: {},
          parent: {
            subscription_details: { subscription: checkoutSubscriptionId },
          },
          lines: subscriptionLines(epochSeconds(30)),
        },
      }),
      [200],
    );
    const entitled = await billing.readBillingStatus(actor);
    expect(entitled.tier).toBe("pro");
    expect(entitled.credits).toBe(20_000);

    // A same-or-lower-tier checkout cannot replace the current subscription.
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      proSubscription({ id: `sub_bdd_lowtier_${suffix}`, customerId }),
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: `cs_bdd_lowtier_${suffix}`,
          subscription: `sub_bdd_lowtier_${suffix}`,
          customer: customerId,
          metadata: null,
        },
      }),
      [200],
    );
    const kept = await billing.readBillingStatus(actor);
    expect(kept.tier).toBe("pro");
    expect(kept.subscriptionStatus).toBe("active");
    expect(kept.credits).toBe(20_000);

    // Dashboard subscriptions for unknown customers are ignored.
    context.mocks.stripe.customers.retrieve.mockResolvedValueOnce({
      id: `cus_bdd_unknown_${suffix}`,
      metadata: {},
    });
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.created",
        object: {
          id: `sub_bdd_unknown_${suffix}`,
          customer: `cus_bdd_unknown_${suffix}`,
          status: "active",
          metadata: {},
          cancel_at_period_end: false,
          items: { data: [{ price: { id: "price_bdd_pro" } }] },
        },
      }),
      [200],
    );
    expect((await billing.readBillingStatus(actor)).tier).toBe("pro");

    // Customer metadata cannot rebind an org bound to another customer.
    context.mocks.stripe.customers.retrieve.mockResolvedValueOnce({
      id: `cus_bdd_other_${suffix}`,
      metadata: { orgId },
    });
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.created",
        object: {
          id: `sub_bdd_rebind_${suffix}`,
          customer: `cus_bdd_other_${suffix}`,
          status: "active",
          metadata: {},
          cancel_at_period_end: false,
          items: { data: [{ price: { id: "price_bdd_pro" } }] },
        },
      }),
      [200],
    );
    const unmoved = await billing.readBillingStatus(actor);
    expect(unmoved.tier).toBe("pro");
    expect(unmoved.subscriptionStatus).toBe("active");

    // invoice.paid for a never-onboarded org creates its metadata from Clerk.
    const lateActor = bdd.user();
    const lateOrgId = orgOf(lateActor);
    const lateCustomerId = `cus_bdd_late_${suffix}`;
    const lateSubscriptionId = `sub_bdd_late_${suffix}`;
    context.mocks.stripe.customers.retrieve.mockResolvedValueOnce({
      id: lateCustomerId,
      metadata: { orgId: lateOrgId },
    });
    context.mocks.clerk.organizations.getOrganization.mockResolvedValueOnce({
      id: lateOrgId,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      proSubscription({ id: lateSubscriptionId, customerId: lateCustomerId }),
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_late_${suffix}`,
          customer: lateCustomerId,
          metadata: {},
          parent: {
            subscription_details: { subscription: lateSubscriptionId },
          },
          lines: subscriptionLines(epochSeconds(30)),
        },
      }),
      [200],
    );
    const lateStatus = await billing.readBillingStatus(lateActor);
    expect(lateStatus.tier).toBe("pro");
    expect(lateStatus.credits).toBe(20_000);
    expect(lateStatus.hasSubscription).toBeTruthy();
  });

  it("grants one-time and custom credit purchases once payment settles", async () => {
    const bdd = createBddApi(context);
    const billing = createBillingMediaApi(context);
    const actor = bdd.user();
    const orgId = orgOf(actor);
    api.configureStripeBillingEnv();
    await bdd.setupOnboarding(actor, { displayName: "BDD Credits Agent" });
    const baselineCredits = (await billing.readBillingStatus(actor)).credits;

    // A one-time checkout before payment settles grants nothing.
    const suffix = randomUUID().slice(0, 8);
    const oneTimeSessionId = `cs_bdd_once_${suffix}`;
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: oneTimeSessionId,
          invoice: null,
          subscription: null,
          customer: null,
          payment_status: "unpaid",
          metadata: {
            purpose: "one_time_purchase",
            orgId,
            campaignKey: "ZERO100",
          },
        },
      }),
      [200],
    );
    expect((await billing.readBillingStatus(actor)).credits).toBe(
      baselineCredits,
    );

    // The async payment success grants the campaign credits once.
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.async_payment_succeeded",
        object: {
          id: oneTimeSessionId,
          invoice: null,
          subscription: null,
          customer: null,
          payment_status: "paid",
          metadata: {
            purpose: "one_time_purchase",
            orgId,
            campaignKey: "ZERO100",
          },
        },
      }),
      [200],
    );
    const afterCampaign = await billing.readBillingStatus(actor);
    expect(afterCampaign.credits).toBe(baselineCredits + 100_000);
    const campaignGrant = afterCampaign.creditGrants.find((grant) => {
      return grant.source === "one_time_purchase";
    });
    expect(campaignGrant?.amount).toBe(100_000);

    // Legacy custom credit checkouts without an invoice grant immediately.
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: `cs_bdd_legacy_${suffix}`,
          invoice: null,
          subscription: null,
          customer: null,
          payment_status: "paid",
          amount_total: 10_000,
          metadata: {
            purpose: "credit_purchase",
            orgId,
            creditsAmountMode: "amount_total",
          },
        },
      }),
      [200],
    );
    expect((await billing.readBillingStatus(actor)).credits).toBe(
      baselineCredits + 200_000,
    );

    // Invoice-backed custom credit checkouts defer to invoice.paid, which
    // grants from the pre-discount subtotal.
    const creditInvoiceId = `in_bdd_credit_${suffix}`;
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: `cs_bdd_invoice_${suffix}`,
          invoice: creditInvoiceId,
          subscription: null,
          customer: null,
          payment_status: "paid",
          amount_subtotal: 10_000,
          metadata: {
            purpose: "credit_purchase",
            orgId,
            creditsAmountMode: "amount_subtotal",
          },
        },
      }),
      [200],
    );
    expect((await billing.readBillingStatus(actor)).credits).toBe(
      baselineCredits + 200_000,
    );

    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: creditInvoiceId,
          customer: null,
          subtotal: 10_000,
          metadata: {
            type: "credit_purchase",
            purpose: "credit_purchase",
            orgId,
            creditsAmountMode: "amount_subtotal",
          },
          parent: null,
        },
      }),
      [200],
    );
    expect((await billing.readBillingStatus(actor)).credits).toBe(
      baselineCredits + 300_000,
    );
  });

  it("restores and schedules cancellations through setup checkouts and schedule webhooks", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsAutomationsApi(context);
    const billing = createBillingMediaApi(context);
    const actor = bdd.user();
    const orgId = orgOf(actor);
    const granted = await runs.grantProEntitlement(actor);
    const suffix = randomUUID().slice(0, 8);
    const periodEnd = epochSeconds(30);

    // The subscription is scheduled for cancellation in Stripe.
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.updated",
        object: {
          id: granted.subscriptionId,
          status: "active",
          cancel_at_period_end: true,
          metadata: {},
          items: {
            data: [
              {
                price: { id: "price_bdd_pro" },
                current_period_end: periodEnd,
              },
            ],
          },
        },
      }),
      [200],
    );
    const scheduled = await billing.readBillingStatus(actor);
    expect(scheduled.cancelAtPeriodEnd).toBeTruthy();
    expect(scheduled.scheduledChange).toStrictEqual({
      type: "cancel",
      targetTier: "pro-suspend",
      effectiveDate: isoOf(periodEnd),
    });

    // Mismatched setup checkouts change nothing.
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: `cs_bdd_wrong_mode_${suffix}`,
          mode: "payment",
          subscription: null,
          customer: granted.customerId,
          metadata: {
            purpose: "billing_restore",
            orgId,
            subscriptionId: granted.subscriptionId,
          },
        },
      }),
      [200],
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: `cs_bdd_no_customer_${suffix}`,
          mode: "setup",
          subscription: null,
          customer: null,
          metadata: {
            purpose: "billing_restore",
            orgId,
            subscriptionId: granted.subscriptionId,
          },
        },
      }),
      [200],
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: `cs_bdd_wrong_sub_${suffix}`,
          mode: "setup",
          subscription: null,
          customer: granted.customerId,
          setup_intent: { id: `seti_bdd_${suffix}`, payment_method: "pm_bdd" },
          metadata: {
            purpose: "billing_restore",
            orgId,
            subscriptionId: `sub_bdd_other_${suffix}`,
          },
        },
      }),
      [200],
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: `cs_bdd_bad_tier_${suffix}`,
          mode: "setup",
          subscription: null,
          customer: granted.customerId,
          metadata: {
            purpose: "billing_downgrade",
            orgId,
            subscriptionId: granted.subscriptionId,
            targetTier: "team",
          },
        },
      }),
      [200],
    );
    expect(
      (await billing.readBillingStatus(actor)).cancelAtPeriodEnd,
    ).toBeTruthy();

    // A restore-purpose setup checkout sets the payment method and restores.
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: `cs_bdd_restore_${suffix}`,
          mode: "setup",
          subscription: null,
          customer: granted.customerId,
          setup_intent: {
            id: `seti_bdd_restore_${suffix}`,
            payment_method: "pm_bdd_restore",
          },
          metadata: {
            purpose: "billing_restore",
            orgId,
            subscriptionId: granted.subscriptionId,
          },
        },
      }),
      [200],
    );
    expect(context.mocks.stripe.customers.update).toHaveBeenCalledWith(
      granted.customerId,
      { invoice_settings: { default_payment_method: "pm_bdd_restore" } },
    );
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      granted.subscriptionId,
      { cancel_at_period_end: false },
    );
    const restored = await billing.readBillingStatus(actor);
    expect(restored.cancelAtPeriodEnd).toBeFalsy();
    expect(restored.scheduledChange).toBeNull();

    // A downgrade-purpose setup checkout (string setup intent refreshed via
    // session retrieve) schedules the cancellation again.
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValueOnce({
      id: `cs_bdd_downgrade_${suffix}`,
      setup_intent: { payment_method: "pm_bdd_downgrade" },
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: granted.subscriptionId,
      status: "active",
      customer: granted.customerId,
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      trial_end: null,
      metadata: {},
      items: {
        data: [
          {
            id: `si_bdd_${suffix}`,
            current_period_start: epochSeconds(0),
            current_period_end: periodEnd,
            quantity: 1,
            price: {
              id: "price_bdd_pro",
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    });
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: `cs_bdd_downgrade_${suffix}`,
          mode: "setup",
          subscription: null,
          customer: granted.customerId,
          setup_intent: `seti_bdd_downgrade_${suffix}`,
          metadata: {
            purpose: "billing_downgrade",
            orgId,
            subscriptionId: granted.subscriptionId,
            targetTier: "pro-suspend",
          },
        },
      }),
      [200],
    );
    expect(context.mocks.stripe.customers.update).toHaveBeenCalledWith(
      granted.customerId,
      { invoice_settings: { default_payment_method: "pm_bdd_downgrade" } },
    );
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      granted.subscriptionId,
      { cancel_at_period_end: true },
    );
    const downgraded = await billing.readBillingStatus(actor);
    expect(downgraded.cancelAtPeriodEnd).toBeTruthy();
    expect(downgraded.scheduledChange?.type).toBe("cancel");

    // A schedule-managed cancellation syncs the final schedule end.
    const scheduleId = `sched_bdd_${suffix}`;
    const finalEnd = epochSeconds(60);
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValueOnce({
      id: scheduleId,
      end_behavior: "cancel",
      current_phase: { start_date: epochSeconds(0), end_date: periodEnd },
      phases: [
        { start_date: epochSeconds(0), end_date: periodEnd },
        { start_date: periodEnd, end_date: finalEnd },
      ],
    });
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.updated",
        object: {
          id: granted.subscriptionId,
          status: "active",
          schedule: scheduleId,
          cancel_at_period_end: false,
          metadata: {},
          items: {
            data: [
              {
                price: { id: "price_bdd_pro" },
                current_period_end: periodEnd,
              },
            ],
          },
        },
      }),
      [200],
    );
    const scheduleManaged = await billing.readBillingStatus(actor);
    expect(scheduleManaged.currentPeriodEnd).toBe(isoOf(finalEnd));
    expect(scheduleManaged.scheduledChange).toStrictEqual({
      type: "cancel",
      targetTier: "pro-suspend",
      effectiveDate: isoOf(finalEnd),
    });

    // Releasing the schedule clears the pending change entirely.
    await api.postStripeEvent(
      stripeEvent({
        type: "subscription_schedule.released",
        object: { id: scheduleId },
      }),
      [200],
    );
    const released = await billing.readBillingStatus(actor);
    expect(released.cancelAtPeriodEnd).toBeFalsy();
    expect(released.scheduledChange).toBeNull();

    // A canceled schedule clears the pending schedule but keeps the
    // cancellation flag visible until Stripe uncancels the subscription.
    const secondScheduleId = `sched_bdd_second_${suffix}`;
    const secondFinalEnd = epochSeconds(90);
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValueOnce({
      id: secondScheduleId,
      end_behavior: "cancel",
      current_phase: { start_date: epochSeconds(0), end_date: periodEnd },
      phases: [{ start_date: periodEnd, end_date: secondFinalEnd }],
    });
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.updated",
        object: {
          id: granted.subscriptionId,
          status: "active",
          schedule: secondScheduleId,
          cancel_at_period_end: false,
          metadata: {},
          items: {
            data: [
              {
                price: { id: "price_bdd_pro" },
                current_period_end: periodEnd,
              },
            ],
          },
        },
      }),
      [200],
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "subscription_schedule.canceled",
        object: { id: secondScheduleId },
      }),
      [200],
    );
    const scheduleCanceled = await billing.readBillingStatus(actor);
    expect(scheduleCanceled.scheduledChange?.type).toBe("cancel");
    expect(scheduleCanceled.scheduledChange?.effectiveDate).toBe(
      isoOf(secondFinalEnd),
    );

    // Uncancelling in Stripe clears the remaining cancellation flag.
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.updated",
        object: {
          id: granted.subscriptionId,
          status: "active",
          cancel_at_period_end: false,
          metadata: {},
          items: { data: [{ price: { id: "price_bdd_pro" } }] },
        },
        previousAttributes: { cancel_at_period_end: true },
      }),
      [200],
    );
    const uncancelled = await billing.readBillingStatus(actor);
    expect(uncancelled.cancelAtPeriodEnd).toBeFalsy();
    expect(uncancelled.scheduledChange).toBeNull();
  });

  it("processes preview Stripe events only for the matching job ref", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsAutomationsApi(context);
    const billing = createBillingMediaApi(context);
    const actor = bdd.user();
    const granted = await runs.grantProEntitlement(actor);
    mockEnv("ENV", "preview");
    mockOptionalEnv("VM0_PREVIEW_JOB_REF", "pr-bdd-123");

    const mismatchedMetadata = {
      vm0_environment: "preview",
      job_ref: "pr-bdd-456",
    };
    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_preview_skip_${randomUUID().slice(0, 8)}`,
          customer: granted.customerId,
          metadata: {},
          parent: {
            subscription_details: {
              subscription: granted.subscriptionId,
              metadata: mismatchedMetadata,
            },
          },
          lines: subscriptionLines(epochSeconds(30)),
        },
      }),
      [200],
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: `cs_bdd_preview_skip_${randomUUID().slice(0, 8)}`,
          subscription: granted.subscriptionId,
          customer: granted.customerId,
          metadata: mismatchedMetadata,
        },
      }),
      [200],
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.created",
        object: {
          id: `sub_bdd_preview_skip_${randomUUID().slice(0, 8)}`,
          customer: granted.customerId,
          status: "active",
          metadata: mismatchedMetadata,
          cancel_at_period_end: false,
          items: { data: [{ price: { id: "price_bdd_pro" } }] },
        },
      }),
      [200],
    );
    const skipped = await billing.readBillingStatus(actor);
    expect(skipped.credits).toBe(20_000);
    expect(skipped.subscriptionStatus).toBe("active");

    // The matching job ref processes normally.
    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_preview_match_${randomUUID().slice(0, 8)}`,
          customer: granted.customerId,
          metadata: {},
          parent: {
            subscription_details: {
              subscription: granted.subscriptionId,
              metadata: { vm0_environment: "preview", job_ref: "pr-bdd-123" },
            },
          },
          lines: subscriptionLines(epochSeconds(45)),
        },
      }),
      [200],
    );
    expect((await billing.readBillingStatus(actor)).credits).toBe(40_000);
  });
});

describe("WHCB-08: Clerk deletion webhooks tear down account state", () => {
  it("cleans up organization state after a verified organization.deleted event", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsAutomationsApi(context);
    const gh = createGithubBddApi(context);
    api.configureClerkWebhookSecret();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    acceptGithubGrantRevocations();

    const actor = bdd.user();
    const granted = await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Org Teardown Agent",
      visibility: "public",
    });
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "survive until teardown",
      modelProvider: "anthropic-api-key",
    });
    expect(run.status).toBe("pending");

    await gh.installGithubApp(actor, agent.agentId, {
      oauthCode: {
        code: `whcb08a-${randomUUID().slice(0, 8)}`,
        githubUserId: newGithubUserId(),
      },
    });
    const schedule = await runs.deployAutomation(actor, {
      name: uniqueAutomationName("teardown"),
      agentId: agent.agentId,
      intervalSeconds: 3600,
      prompt: "scheduled teardown probe",
      timezone: "UTC",
      enabled: false,
    });
    expect(schedule.automation.name).toContain("teardown");
    const botToken = await registerTelegramBot(actor, agent.agentId);
    await runs.upsertUserPermissionGrant(actor, {
      agentId: agent.agentId,
      connectorRef: "slack",
      permission: "channels:read",
      action: "allow",
    });
    await expect(
      runs.listUserPermissionGrants(actor, agent.agentId),
    ).resolves.toHaveLength(1);
    expect((await runs.listAutomations(actor)).automations).toHaveLength(1);

    // The first delivery hits a failing Stripe cancellation (a per-step
    // failure the cleanup continues over) and then a failing org S3 listing,
    // which aborts the rest of the cleanup without surfacing in the
    // webhook response.
    context.mocks.stripe.subscriptions.cancel.mockRejectedValueOnce(
      new Error("stripe unavailable"),
    );
    context.mocks.s3.send.mockRejectedValueOnce(new Error("R2 unavailable"));
    api.verifyNextClerkWebhook({
      type: "organization.deleted",
      data: { id: orgOf(actor) },
    });
    const firstDelivery = await api.requestClerkWebhook("{}", {}, [200]);
    expect(firstDelivery.body).toBe("OK");
    await flushWaitUntilForTest();
    await waitForExpectation(() => {
      expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledWith(
        granted.subscriptionId,
      );
      expect(context.mocks.telegram.deleteWebhook).toHaveBeenCalledWith(
        botToken,
      );
    });
    const survivingRun = await runs.requestReadRun(actor, run.runId, [200]);
    expect(survivingRun.status).toBe(200);
    // The onboarding default agent and the teardown agent both survive.
    await expect(bdd.listAgents(actor)).resolves.toHaveLength(2);

    // The redelivered event completes the teardown, deleting storage
    // objects and all org-scoped resources.
    const deletedS3Keys: string[] = [];
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const input = commandInput(command);
      if (typeof input.Prefix === "string") {
        return Promise.resolve({
          Contents: [
            {
              Key: `${input.Prefix}/archive.bin`,
              Size: 1,
              LastModified: nowDate(),
            },
          ],
        });
      }
      const removal = input.Delete as
        | { readonly Objects?: readonly { readonly Key?: string }[] }
        | undefined;
      for (const object of removal?.Objects ?? []) {
        if (object.Key) {
          deletedS3Keys.push(object.Key);
        }
      }
      return Promise.resolve({});
    });
    api.verifyNextClerkWebhook({
      type: "organization.deleted",
      data: { id: orgOf(actor) },
    });
    const redelivery = await api.requestClerkWebhook("{}", {}, [200]);
    expect(redelivery.body).toBe("OK");
    await flushWaitUntilForTest();

    await expect
      .poll(() => {
        return deletedS3Keys.length;
      })
      .toBeGreaterThan(0);
    // The redelivered webhook responds OK before the teardown finishes, so
    // the resource deletions land asynchronously — poll instead of asserting
    // a single snapshot.
    await waitForExpectation(async () => {
      await runs.requestReadRun(actor, run.runId, [404]);
    });
    await waitForExpectation(async () => {
      await expect(bdd.listAgents(actor)).resolves.toStrictEqual([]);
    });
    await waitForExpectation(async () => {
      expect((await runs.listAutomations(actor)).automations).toStrictEqual([]);
    });

    // An org without a live subscription skips the Stripe cancellation.
    const cancelCalls =
      context.mocks.stripe.subscriptions.cancel.mock.calls.length;
    const plainActor = bdd.user();
    await bdd.setupOnboarding(plainActor, {
      displayName: "BDD Plain Teardown",
    });
    api.verifyNextClerkWebhook({
      type: "organization.deleted",
      data: { id: orgOf(plainActor) },
    });
    await api.requestClerkWebhook("{}", {}, [200]);
    await expect
      .poll(async () => {
        const agents = await bdd.listAgents(plainActor);
        return agents.length;
      })
      .toBe(0);
    expect(context.mocks.stripe.subscriptions.cancel.mock.calls).toHaveLength(
      cancelCalls,
    );
  });

  it("cleans up user state after a verified user.deleted event", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsAutomationsApi(context);
    const gh = createGithubBddApi(context);
    api.configureClerkWebhookSecret();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    acceptGithubGrantRevocations();

    const doomed = bdd.user();
    await runs.grantProEntitlement(doomed);
    await runs.ensureOrgModelProvider(doomed);
    const peer = bdd.user({ orgId: doomed.orgId, orgRole: "org:member" });
    const sharedAgent = await bdd.createAgent(peer, {
      displayName: "BDD Shared Grant Agent",
      visibility: "public",
    });
    const doomedAgent = await bdd.createAgent(doomed, {
      displayName: "BDD Doomed Agent",
      visibility: "private",
    });

    const doomedKey = await runs.createApiKey(doomed);
    const doomedBearer = `Bearer ${doomedKey.token}`;
    const livePoll = await runs.requestPollRunnerAs(
      doomedBearer,
      { group: runnerGroup, profiles: ["vm0/default"] },
      [200],
    );
    expect(livePoll.status).toBe(200);

    const run = await runs.createRun(doomed, {
      agentId: sharedAgent.agentId,
      prompt: "user teardown run",
      modelProvider: "anthropic-api-key",
    });
    expect(run.status).toBe("pending");

    // The installation's default agent is the peer's compose, so the
    // installation itself survives the user teardown while the doomed
    // user's GitHub link is removed.
    await gh.installGithubApp(doomed, sharedAgent.agentId, {
      oauthCode: {
        code: `whcb08b-${randomUUID().slice(0, 8)}`,
        githubUserId: newGithubUserId(),
      },
    });
    expect((await gh.readInstallation(doomed)).isConnected).toBeTruthy();
    const botToken = await registerTelegramBot(doomed, doomedAgent.agentId);

    await runs.upsertUserPermissionGrant(doomed, {
      agentId: sharedAgent.agentId,
      connectorRef: "slack",
      permission: "channels:read",
      action: "allow",
    });
    await runs.upsertUserPermissionGrant(peer, {
      agentId: sharedAgent.agentId,
      connectorRef: "slack",
      permission: "chat:write",
      action: "deny",
    });

    // User storage cleanup is best-effort: a failing S3 listing must not
    // stop the rest of the teardown.
    context.mocks.s3.send.mockRejectedValue(new Error("R2 unavailable"));
    api.verifyNextClerkWebhook({
      type: "user.deleted",
      data: { id: doomed.userId },
    });
    const response = await api.requestClerkWebhook("{}", {}, [200]);
    expect(response.body).toBe("OK");
    context.mocks.s3.send.mockResolvedValue({});

    await waitForExpectation(() => {
      expect(context.mocks.telegram.deleteWebhook).toHaveBeenCalledWith(
        botToken,
      );
    });
    let revokedPoll:
      | Awaited<ReturnType<typeof runs.requestPollRunnerAs>>
      | undefined;
    await expect
      .poll(async () => {
        revokedPoll = await runs.requestPollRunnerAs(
          doomedBearer,
          { group: runnerGroup, profiles: ["vm0/default"] },
          [200, 401],
        );
        return revokedPoll.status;
      })
      .toBe(401);
    if (!revokedPoll || revokedPoll.status !== 401) {
      throw new Error("Expected deleted user's runner token to be revoked");
    }
    expectApiError(revokedPoll.body);
    await runs.requestReadRun(doomed, run.runId, [404]);
    expect((await gh.readInstallation(doomed)).isConnected).toBeFalsy();
    await expect(
      runs.listUserPermissionGrants(doomed, sharedAgent.agentId),
    ).resolves.toStrictEqual([]);
    const peerGrants = await runs.listUserPermissionGrants(
      peer,
      sharedAgent.agentId,
    );
    expect(peerGrants).toHaveLength(1);
    expect(peerGrants[0]).toMatchObject({
      permission: "chat:write",
      action: "deny",
    });
  });
});
