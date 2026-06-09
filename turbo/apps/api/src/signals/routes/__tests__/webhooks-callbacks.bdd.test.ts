import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-helpers";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const api = createWebhookCallbackApi(context);

describe("WHCB-01: third-party webhook verification boundaries", () => {
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
