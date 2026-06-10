import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { nowDate } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-helpers";
import { expectApiError } from "./helpers/api-bdd";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const api = createWebhookCallbackApi(context);

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
