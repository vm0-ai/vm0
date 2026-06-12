import { createHmac, randomUUID } from "node:crypto";

import { internalCallbacksAgentContract } from "@vm0/api-contracts/contracts/internal-callbacks-agent";
import type { InternalCallbackBody } from "@vm0/api-contracts/contracts/internal-callbacks-shared";
import {
  internalEventConsumerAxiomContract,
  internalEventConsumerChatAssistantContract,
  type eventConsumerPayloadSchema,
} from "@vm0/api-contracts/contracts/internal-event-consumers";
import {
  zeroEmailInboundContract,
  zeroEmailTriggerCallbackContract,
} from "@vm0/api-contracts/contracts/zero-email";
import {
  webhookBuiltInGenerationBytePlusContract,
  webhookBuiltInGenerationFalContract,
  webhookCheckpointsContract,
  webhookCheckpointsPrepareHistoryContract,
  webhookClerkContract,
  webhookCompleteContract,
  webhookEventsContract,
  webhookHeartbeatContract,
  webhookModelUsageObservationContract,
  webhookStoragesCommitContract,
  webhookStoragesPrepareContract,
  webhookStripeContract,
  webhookTelemetryContract,
  webhookUsageEventContract,
} from "@vm0/api-contracts/contracts/webhooks";
import { HttpResponse, http } from "msw";
import type StripeSDK from "stripe";
import { Webhook } from "svix";
import type { z } from "zod";

import { createApp } from "../../../../app-factory";
import { env, mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { server } from "../../../../mocks/server";
import { generateSandboxToken } from "../../../auth/tokens";
import { mockStripeClient } from "../../../external/stripe-client";
import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";

type EventConsumerPayload = z.input<typeof eventConsumerPayloadSchema>;
type AgentEventsBody = z.infer<(typeof webhookEventsContract.send)["body"]>;
type AgentCompleteBody = z.infer<
  (typeof webhookCompleteContract.complete)["body"]
>;
type AgentCheckpointBody = z.infer<
  (typeof webhookCheckpointsContract.create)["body"]
>;
type AgentCheckpointPrepareHistoryBody = z.infer<
  (typeof webhookCheckpointsPrepareHistoryContract.prepare)["body"]
>;
type AgentHeartbeatBody = z.infer<
  (typeof webhookHeartbeatContract.send)["body"]
>;
type AgentTelemetryBody = z.infer<
  (typeof webhookTelemetryContract.send)["body"]
>;
type AgentUsageEventBody = z.infer<
  (typeof webhookUsageEventContract.send)["body"]
>;
type AgentModelUsageObservationBody = z.infer<
  (typeof webhookModelUsageObservationContract.send)["body"]
>;
type AgentStoragePrepareBody = z.infer<
  (typeof webhookStoragesPrepareContract.prepare)["body"]
>;
type AgentStorageCommitBody = z.infer<
  (typeof webhookStoragesCommitContract.commit)["body"]
>;
type EmailTriggerCallbackBody = z.infer<
  (typeof zeroEmailTriggerCallbackContract.post)["body"]
>;

interface Vm0SignatureHeaders {
  readonly "x-vm0-signature": string;
  readonly "x-vm0-timestamp": string;
}

interface CapturedInternalCallbackDelivery {
  readonly body: string;
  readonly headers: Record<string, string>;
}

/**
 * First captured delivery whose JSON envelope carries the given callback
 * status. Throws when no such delivery was dispatched yet.
 */
export function callbackDeliveryWithStatus(
  deliveries: readonly CapturedInternalCallbackDelivery[],
  status: "completed" | "failed" | "progress",
): CapturedInternalCallbackDelivery {
  const delivery = deliveries.find((entry) => {
    const parsed: unknown = JSON.parse(entry.body);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { readonly status?: unknown }).status === status
    );
  });
  if (!delivery) {
    throw new Error(`Expected a captured ${status} callback delivery`);
  }
  return delivery;
}

interface SvixHeaders {
  readonly "svix-id": string;
  readonly "svix-timestamp": string;
  readonly "svix-signature": string;
}

interface SandboxWebhookHeaders {
  readonly authorization?: string;
}

interface ClerkWebhookEvent {
  readonly type: string;
  readonly data: unknown;
}

type GithubWebhookStatus = 200 | 400 | 401 | 503;

interface GithubWebhookResponse {
  readonly status: GithubWebhookStatus;
  readonly body: unknown;
  readonly headers: Headers;
}

type BuiltInGenerationProvider = "fal" | "byteplus";
const RESEND_WEBHOOK_SECRET = "whsec_test";
interface StripeWebhookResponse {
  readonly status: 200 | 500;
  readonly body: unknown;
}

function serializedTsRestBody(body: unknown): string {
  return JSON.stringify(body);
}

async function parseRawResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return await response.json();
  }
  if (contentType.startsWith("text/")) {
    return await response.text();
  }
  return await response.blob();
}

function builtInGenerationToken(args: {
  readonly provider: BuiltInGenerationProvider;
  readonly generationId: string;
  readonly visualKey?: string;
}): string {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update([args.provider, args.generationId, args.visualKey ?? ""].join(":"))
    .digest("hex");
}

function vm0SignatureHeaders(body: unknown): Vm0SignatureHeaders {
  const timestamp = Math.floor(now() / 1000);
  return {
    "x-vm0-signature": createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
      .update(`${timestamp}.${serializedTsRestBody(body)}`)
      .digest("hex"),
    "x-vm0-timestamp": String(timestamp),
  };
}

function resendSvixHeaders(body: unknown): SvixHeaders {
  const id = `msg_${randomUUID()}`;
  const timestamp = new Date(now());
  return {
    "svix-id": id,
    "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "svix-signature": new Webhook(RESEND_WEBHOOK_SECRET).sign(
      id,
      timestamp,
      serializedTsRestBody(body),
    ),
  };
}

function githubWebhookHeaders(
  body: string,
  event: string,
): Record<string, string> {
  return {
    "x-github-delivery": `delivery-${randomUUID()}`,
    "x-github-event": event,
    "x-hub-signature-256": `sha256=${createHmac("sha256", "github-bdd-secret")
      .update(body)
      .digest("hex")}`,
  };
}

async function requestRawGithubWebhook(
  context: TestContext,
  body: string,
  headers: Record<string, string>,
): Promise<GithubWebhookResponse> {
  const response = await createApp({ signal: context.signal }).request(
    "/api/webhooks/github",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body,
    },
  );
  const result = {
    body: await parseRawResponseBody(response),
    headers: response.headers,
  };

  switch (response.status) {
    case 200: {
      return { status: 200, ...result };
    }
    case 400: {
      return { status: 400, ...result };
    }
    case 401: {
      return { status: 401, ...result };
    }
    case 503: {
      return { status: 503, ...result };
    }
    default: {
      throw new Error(`Unexpected GitHub webhook status ${response.status}`);
    }
  }
}

function sandboxWebhookHeaders(args: {
  readonly runId: string;
  readonly tokenRunId?: string;
}): SandboxWebhookHeaders {
  return {
    authorization: `Bearer ${generateSandboxToken(
      "user_bdd_sandbox_webhook",
      args.tokenRunId ?? args.runId,
      "org_bdd_sandbox_webhook",
    )}`,
  };
}

export function createWebhookCallbackApi(context: TestContext) {
  return {
    disableStripeWebhookSecret(): void {
      mockOptionalEnv("STRIPE_WEBHOOK_SECRET", undefined);
    },

    configureStripeWebhookSecret(): void {
      mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_bdd_stripe");
    },

    /**
     * Full Stripe billing Given for webhook chains: price map, one-time
     * campaign registry, webhook secret, and the mocked Stripe SDK client.
     * Uses the same price ids as `grantProEntitlement`, so the two can be
     * combined in any order within a test.
     */
    configureStripeBillingEnv(): void {
      mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
      mockEnv(
        "ZERO_PRICE",
        JSON.stringify({ pro: ["price_bdd_pro"], team: ["price_bdd_team"] }),
      );
      mockEnv(
        "ZERO_ONE_TIME_CAMPAIGN",
        JSON.stringify({
          ZERO100: {
            priceId: "price_bdd_campaign",
            couponId: "coupon_bdd_campaign",
          },
        }),
      );
      mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_bdd_stripe");
    },

    /**
     * Posts one signed Stripe event through the public webhook route. The
     * `constructEvent` trust boundary is mocked once per call so later posts
     * never leak a stale event. Raw request (not ts-rest) so processing 500s
     * stay assertable.
     */
    async postStripeEvent(
      event: unknown,
      statuses: readonly (200 | 500)[],
    ): Promise<StripeWebhookResponse> {
      context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);
      const response = await createApp({ signal: context.signal }).request(
        "/api/webhooks/stripe",
        {
          method: "POST",
          headers: { "stripe-signature": "t=1,v1=bdd" },
          body: serializedTsRestBody(event),
        },
      );
      const body = await parseRawResponseBody(response);
      const status = response.status;
      if ((status !== 200 && status !== 500) || !statuses.includes(status)) {
        throw new Error(
          `Expected Stripe webhook status in [${statuses.join(", ")}], received ${status}: ${JSON.stringify(body)}`,
        );
      }
      return { status, body };
    },

    acceptNextStripeWebhookEvent(event: unknown): void {
      context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);
    },

    rejectNextStripeWebhookSignature(): void {
      context.mocks.stripe.webhooks.constructEvent.mockImplementationOnce(
        () => {
          throw new Error("Invalid Stripe webhook signature");
        },
      );
    },

    async requestStripeWebhook(
      body: string,
      headers: Record<string, string>,
      statuses: readonly (200 | 401 | 503)[],
    ) {
      return await accept(
        setupApp({ context })(webhookStripeContract).post({
          body,
          extraHeaders: headers,
        }),
        statuses,
      );
    },

    configureClerkWebhookSecret(): void {
      mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_bdd_clerk");
    },

    rejectNextClerkWebhookVerification(): void {
      context.mocks.clerk.verifyWebhook.mockRejectedValueOnce(
        new Error("Invalid Clerk webhook verification"),
      );
    },

    verifyNextClerkWebhook(event: ClerkWebhookEvent): void {
      context.mocks.clerk.verifyWebhook.mockResolvedValueOnce(event);
    },

    async requestClerkWebhook(
      body: string,
      headers: Record<string, string>,
      statuses: readonly (200 | 401)[],
    ) {
      return await accept(
        setupApp({ context })(webhookClerkContract).post({
          body,
          extraHeaders: headers,
        }),
        statuses,
      );
    },

    configureGithubWebhookSecret(): void {
      mockOptionalEnv("GITHUB_APP_WEBHOOK_SECRET", "github-bdd-secret");
    },

    disableGithubWebhookSecret(): void {
      mockOptionalEnv("GITHUB_APP_WEBHOOK_SECRET", undefined);
    },

    configureResendWebhookSecret(): void {
      mockEnv("RESEND_WEBHOOK_SECRET", RESEND_WEBHOOK_SECRET);
    },

    disableResendApiKey(): void {
      mockEnv("RESEND_API_KEY", undefined);
    },

    async requestGithubWebhook(
      body: string,
      headers: Record<string, string>,
      statuses: readonly (200 | 400 | 401 | 503)[],
    ) {
      return await accept(
        requestRawGithubWebhook(context, body, headers),
        statuses,
      );
    },

    signedGithubWebhookHeaders(
      body: string,
      event: string,
    ): Record<string, string> {
      return githubWebhookHeaders(body, event);
    },

    signedResendWebhookHeaders(body: unknown): SvixHeaders {
      return resendSvixHeaders(body);
    },

    async requestResendInboundWebhook(
      body: unknown,
      headers: Partial<SvixHeaders>,
      statuses: readonly (200 | 401)[],
    ) {
      return await accept(
        setupApp({ context })(zeroEmailInboundContract).post({
          headers,
          body,
        }),
        statuses,
      );
    },

    async requestEmailTriggerCallback(
      body: EmailTriggerCallbackBody,
      statuses: readonly (200 | 400 | 401 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(zeroEmailTriggerCallbackContract).post({
          headers: {},
          body,
        }),
        statuses,
      );
    },

    falGenerationWebhookToken(
      generationId: string,
      visualKey?: string,
    ): string {
      return builtInGenerationToken({
        provider: "fal",
        generationId,
        visualKey,
      });
    },

    bytePlusGenerationWebhookToken(
      generationId: string,
      visualKey?: string,
    ): string {
      return builtInGenerationToken({
        provider: "byteplus",
        generationId,
        visualKey,
      });
    },

    async requestFalGenerationWebhook(args: {
      readonly generationId: string;
      readonly token: string;
      readonly visualKey?: string;
      readonly body: unknown;
      readonly statuses: readonly (200 | 400 | 401 | 503)[];
    }) {
      return await accept(
        setupApp({ context })(webhookBuiltInGenerationFalContract).post({
          params: { generationId: args.generationId },
          query: { token: args.token, visualKey: args.visualKey },
          body: args.body as string,
        }),
        args.statuses,
      );
    },

    async requestBytePlusGenerationWebhook(args: {
      readonly generationId: string;
      readonly token: string;
      readonly visualKey?: string;
      readonly body: unknown;
      readonly statuses: readonly (200 | 400 | 401 | 503)[];
    }) {
      return await accept(
        setupApp({ context })(webhookBuiltInGenerationBytePlusContract).post({
          params: { generationId: args.generationId },
          query: { token: args.token, visualKey: args.visualKey },
          body: args.body as string,
        }),
        args.statuses,
      );
    },

    async requestAgentCallback(
      body: InternalCallbackBody,
      statuses: readonly (200 | 400 | 401 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(internalCallbacksAgentContract).post({
          headers: {},
          body,
        }),
        statuses,
      );
    },

    async requestInvalidAgentCallbackBody(
      body: string,
      statuses: readonly (400 | 401 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(internalCallbacksAgentContract).post({
          headers: {},
          body: body as unknown as InternalCallbackBody,
        }),
        statuses,
      );
    },

    signedEventConsumerHeaders(body: unknown): Vm0SignatureHeaders {
      return vm0SignatureHeaders(body);
    },

    /**
     * Records real dispatcher deliveries POSTed to an internal callback URL
     * without letting them reach the route (responds 500, marking the
     * callback row failed). The captured raw body and headers form a
     * legitimately signed request that tests replay into any callback path —
     * `callbackRoute` resolves the row by the body's callbackId/runId, never
     * by path, so cross-path replays still pass signature verification.
     */
    captureInternalCallbackDeliveries(
      path: string,
    ): readonly CapturedInternalCallbackDelivery[] {
      const deliveries: CapturedInternalCallbackDelivery[] = [];
      server.use(
        http.post(`http://localhost:3000${path}`, async ({ request }) => {
          deliveries.push({
            body: await request.text(),
            headers: Object.fromEntries(request.headers.entries()),
          });
          return HttpResponse.json(
            { error: "captured for replay" },
            { status: 500 },
          );
        }),
      );
      return deliveries;
    },

    /** Re-POSTs a captured delivery into the app verbatim on any callback path. */
    async replayInternalCallback(
      path: string,
      delivery: CapturedInternalCallbackDelivery,
      overrides: { readonly signature?: string } = {},
    ): Promise<Response> {
      const headers: Record<string, string> = { ...delivery.headers };
      if (overrides.signature !== undefined) {
        headers["x-vm0-signature"] = overrides.signature;
      }
      const app = createApp({ signal: context.signal });
      return await app.request(path, {
        method: "POST",
        headers,
        body: delivery.body,
      });
    },

    /** Captured signature with one flipped hex character. */
    tamperedSignature(delivery: CapturedInternalCallbackDelivery): string {
      const signature = delivery.headers["x-vm0-signature"] ?? "";
      const flipped = signature.startsWith("a") ? "b" : "a";
      return `${flipped}${signature.slice(1)}`;
    },

    async requestAxiomEventConsumer(
      body: EventConsumerPayload,
      headers: Partial<Vm0SignatureHeaders>,
      statuses: readonly (200 | 401 | 503)[],
    ) {
      return await accept(
        setupApp({ context })(internalEventConsumerAxiomContract).ingest({
          headers,
          body,
        }),
        statuses,
      );
    },

    async requestChatAssistantEventConsumer(
      body: EventConsumerPayload,
      headers: Partial<Vm0SignatureHeaders>,
      statuses: readonly (200 | 401)[],
    ) {
      return await accept(
        setupApp({ context })(
          internalEventConsumerChatAssistantContract,
        ).process({
          headers,
          body,
        }),
        statuses,
      );
    },

    async requestInvalidChatAssistantEventConsumerBody(
      body: string,
      headers: Vm0SignatureHeaders,
      statuses: readonly 401[],
    ) {
      return await accept(
        setupApp({ context })(
          internalEventConsumerChatAssistantContract,
        ).process({
          headers,
          body: body as unknown as EventConsumerPayload,
        }),
        statuses,
      );
    },

    sandboxWebhookHeaders,

    async requestAgentEvents(
      body: AgentEventsBody,
      headers: SandboxWebhookHeaders,
      statuses: readonly (200 | 400 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(webhookEventsContract).send({
          headers,
          body,
        }),
        statuses,
      );
    },

    async requestAgentEventsUnchecked(
      body: unknown,
      headers: SandboxWebhookHeaders,
      statuses: readonly (400 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(webhookEventsContract).send({
          headers,
          body: body as AgentEventsBody,
        }),
        statuses,
      );
    },

    async requestAgentComplete(
      body: AgentCompleteBody,
      headers: SandboxWebhookHeaders,
      statuses: readonly (200 | 400 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(webhookCompleteContract).complete({
          headers,
          body,
        }),
        statuses,
      );
    },

    async requestAgentCompleteUnchecked(
      body: unknown,
      headers: SandboxWebhookHeaders,
      statuses: readonly (400 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(webhookCompleteContract).complete({
          headers,
          body: body as AgentCompleteBody,
        }),
        statuses,
      );
    },

    async requestAgentCheckpoint(
      body: AgentCheckpointBody,
      headers: SandboxWebhookHeaders,
      statuses: readonly (200 | 400 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(webhookCheckpointsContract).create({
          headers,
          body,
        }),
        statuses,
      );
    },

    async requestAgentCheckpointUnchecked(
      body: unknown,
      headers: SandboxWebhookHeaders,
      statuses: readonly (400 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(webhookCheckpointsContract).create({
          headers,
          body: body as AgentCheckpointBody,
        }),
        statuses,
      );
    },

    async requestAgentCheckpointPrepareHistory(
      body: AgentCheckpointPrepareHistoryBody,
      headers: SandboxWebhookHeaders,
      statuses: readonly (200 | 400 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(webhookCheckpointsPrepareHistoryContract).prepare(
          {
            headers,
            body,
          },
        ),
        statuses,
      );
    },

    async requestAgentCheckpointPrepareHistoryUnchecked(
      body: unknown,
      headers: SandboxWebhookHeaders,
      statuses: readonly (400 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(webhookCheckpointsPrepareHistoryContract).prepare(
          {
            headers,
            body: body as AgentCheckpointPrepareHistoryBody,
          },
        ),
        statuses,
      );
    },

    async requestAgentHeartbeat(
      body: AgentHeartbeatBody,
      headers: SandboxWebhookHeaders,
      statuses: readonly (200 | 400 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(webhookHeartbeatContract).send({
          headers,
          body,
        }),
        statuses,
      );
    },

    async requestAgentHeartbeatUnchecked(
      body: unknown,
      headers: SandboxWebhookHeaders,
      statuses: readonly (400 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(webhookHeartbeatContract).send({
          headers,
          body: body as AgentHeartbeatBody,
        }),
        statuses,
      );
    },

    async requestAgentTelemetry(
      body: AgentTelemetryBody,
      headers: SandboxWebhookHeaders,
      statuses: readonly (200 | 400 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(webhookTelemetryContract).send({
          headers,
          body,
        }),
        statuses,
      );
    },

    async requestAgentTelemetryUnchecked(
      body: unknown,
      headers: SandboxWebhookHeaders,
      statuses: readonly (400 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(webhookTelemetryContract).send({
          headers,
          body: body as AgentTelemetryBody,
        }),
        statuses,
      );
    },

    async requestAgentUsageEvent(
      body: AgentUsageEventBody,
      headers: SandboxWebhookHeaders,
      statuses: readonly (200 | 400 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(webhookUsageEventContract).send({
          headers,
          body,
        }),
        statuses,
      );
    },

    async requestAgentUsageEventUnchecked(
      body: unknown,
      headers: SandboxWebhookHeaders,
      statuses: readonly (400 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(webhookUsageEventContract).send({
          headers,
          body: body as AgentUsageEventBody,
        }),
        statuses,
      );
    },

    async requestAgentModelUsageObservation(
      body: AgentModelUsageObservationBody,
      headers: SandboxWebhookHeaders,
      statuses: readonly (200 | 400 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(webhookModelUsageObservationContract).send({
          headers,
          body,
        }),
        statuses,
      );
    },

    async requestAgentModelUsageObservationUnchecked(
      body: unknown,
      headers: SandboxWebhookHeaders,
      statuses: readonly (400 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(webhookModelUsageObservationContract).send({
          headers,
          body: body as AgentModelUsageObservationBody,
        }),
        statuses,
      );
    },

    async requestAgentStoragePrepare(
      body: AgentStoragePrepareBody,
      headers: SandboxWebhookHeaders,
      statuses: readonly (200 | 400 | 401 | 404 | 413 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(webhookStoragesPrepareContract).prepare({
          headers,
          body,
        }),
        statuses,
      );
    },

    async requestAgentStoragePrepareUnchecked(
      body: unknown,
      headers: SandboxWebhookHeaders,
      statuses: readonly (400 | 401 | 404 | 413 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(webhookStoragesPrepareContract).prepare({
          headers,
          body: body as AgentStoragePrepareBody,
        }),
        statuses,
      );
    },

    async requestAgentStorageCommit(
      body: AgentStorageCommitBody,
      headers: SandboxWebhookHeaders,
      statuses: readonly (200 | 400 | 401 | 404 | 409 | 413 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(webhookStoragesCommitContract).commit({
          headers,
          body,
        }),
        statuses,
      );
    },

    async requestAgentStorageCommitUnchecked(
      body: unknown,
      headers: SandboxWebhookHeaders,
      statuses: readonly (400 | 401 | 404 | 409 | 413 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(webhookStoragesCommitContract).commit({
          headers,
          body: body as AgentStorageCommitBody,
        }),
        statuses,
      );
    },
  };
}
