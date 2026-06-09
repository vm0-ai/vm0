import { createHmac, randomUUID } from "node:crypto";

import { internalCallbacksAgentContract } from "@vm0/api-contracts/contracts/internal-callbacks-agent";
import type { InternalCallbackBody } from "@vm0/api-contracts/contracts/internal-callbacks-shared";
import {
  internalEventConsumerChatAssistantContract,
  type eventConsumerPayloadSchema,
} from "@vm0/api-contracts/contracts/internal-event-consumers";
import { zeroEmailInboundContract } from "@vm0/api-contracts/contracts/zero-email";
import {
  webhookBuiltInGenerationBytePlusContract,
  webhookBuiltInGenerationFalContract,
  webhookClerkContract,
  webhookGithubContract,
  webhookStripeContract,
} from "@vm0/api-contracts/contracts/webhooks";
import { Webhook } from "svix";
import type { z } from "zod";

import { env, mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";

type EventConsumerPayload = z.input<typeof eventConsumerPayloadSchema>;

interface Vm0SignatureHeaders {
  readonly "x-vm0-signature": string;
  readonly "x-vm0-timestamp": string;
}

interface SvixHeaders {
  readonly "svix-id": string;
  readonly "svix-timestamp": string;
  readonly "svix-signature": string;
}

type BuiltInGenerationProvider = "fal" | "byteplus";
const RESEND_WEBHOOK_SECRET = "whsec_test";

function serializedTsRestBody(body: unknown): string {
  return JSON.stringify(body);
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

export function createWebhookCallbackApi(context: TestContext) {
  return {
    configureStripeWebhookSecret(): void {
      mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_bdd_stripe");
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

    configureResendWebhookSecret(): void {
      mockEnv("RESEND_WEBHOOK_SECRET", RESEND_WEBHOOK_SECRET);
    },

    async requestGithubWebhook(
      body: string,
      headers: Record<string, string>,
      statuses: readonly (200 | 400 | 401 | 503)[],
    ) {
      return await accept(
        setupApp({ context })(webhookGithubContract).post({
          body,
          extraHeaders: headers,
        }),
        statuses,
      );
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
  };
}
