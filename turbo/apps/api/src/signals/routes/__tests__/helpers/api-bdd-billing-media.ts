import { randomUUID } from "node:crypto";

import type StripeSDK from "stripe";
import { audioTranscriptionsV1Contract } from "@vm0/api-contracts/contracts/audio-transcriptions-v1";
import {
  cronAggregateInsightsContract,
  cronAggregateUsageContract,
  cronProcessUsageEventsContract,
} from "@vm0/api-contracts/contracts/cron";
import { generateImageContract } from "@vm0/api-contracts/contracts/generate-image";
import { onboardingSetupContract } from "@vm0/api-contracts/contracts/onboarding";
import { usageContract } from "@vm0/api-contracts/contracts/usage";
import { zeroAttributionContract } from "@vm0/api-contracts/contracts/zero-attribution";
import { zeroBankingContract } from "@vm0/api-contracts/contracts/zero-banking";
import {
  zeroBillingAutoRechargeContract,
  zeroBillingCheckoutContract,
  zeroBillingCreditCheckoutContract,
  zeroBillingDowngradeContract,
  zeroBillingInvoicesContract,
  zeroBillingPortalContract,
  zeroBillingRedeemCodeContract,
  zeroBillingRedeemContract,
  zeroBillingRestoreContract,
  zeroBillingStatusContract,
  type AutoRechargeConfig,
  type BillingInvoicesResponse,
  type BillingStatusResponse,
  type CreditCheckoutRequest,
  type RedeemCodeRequest,
  type RedeemRequest,
} from "@vm0/api-contracts/contracts/zero-billing";
import { zeroBuiltInGenerationContract } from "@vm0/api-contracts/contracts/zero-built-in-generation";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import {
  zeroInsightsContract,
  zeroInsightsRangeContract,
  type InsightsRangeResponse,
  type InsightsResponse,
} from "@vm0/api-contracts/contracts/zero-insights";
import { zeroImageIoGenerateContract } from "@vm0/api-contracts/contracts/zero-image-io-generate";
import { zeroMapsContract } from "@vm0/api-contracts/contracts/zero-maps";
import { zeroUsageRunsContract } from "@vm0/api-contracts/contracts/zero-usage-daily";
import { zeroUsageInsightContract } from "@vm0/api-contracts/contracts/zero-usage-insight";
import { zeroUsageMembersContract } from "@vm0/api-contracts/contracts/zero-usage";
import {
  zeroUsageRecordContract,
  type UsageRecordRange,
} from "@vm0/api-contracts/contracts/zero-usage-record";
import { zeroVideoIoGenerateContract } from "@vm0/api-contracts/contracts/zero-video-io-generate";
import { zeroVoiceIoQuotaContract } from "@vm0/api-contracts/contracts/zero-voice-io-quota";
import { zeroVoiceIoSpeechContract } from "@vm0/api-contracts/contracts/zero-voice-io-speech";
import { zeroVoiceIoSttContract } from "@vm0/api-contracts/contracts/zero-voice-io-stt";

import { mockEnv } from "../../../../lib/env";
import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";
import {
  mockListStripeInvoices,
  mockStripeClient,
} from "../../../external/stripe-client";
import { modelStatsContract } from "../../model-stats";
import type { ApiTestUser, OnboardingSetupBody } from "./api-bdd";
import { createZeroRouteMocks } from "./zero-route-test";

type ClerkOrgRole = "org:admin" | "org:member";

interface AuthHeaders {
  readonly authorization?: string;
}

interface ClerkUserProfile {
  readonly id: string;
  readonly emailAddresses: readonly {
    readonly id: string;
    readonly emailAddress: string;
  }[];
  readonly primaryEmailAddressId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly privateMetadata: Readonly<Record<string, unknown>>;
}

interface ClerkOrganizationMembership {
  readonly organization?: {
    readonly id: string;
  };
  readonly publicUserData?: {
    readonly userId: string;
  };
  readonly role: ClerkOrgRole;
  readonly createdAt: number;
}

interface StripeInvoice {
  readonly id: string;
  readonly number: string | null;
  readonly created: number;
  readonly amount_paid: number;
  readonly status: string | null;
  readonly hosted_invoice_url: string | null;
}

interface CheckoutBody {
  readonly tier: "pro" | "team";
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly trialDays?: 7;
}

interface PortalBody {
  readonly returnUrl: string;
}

interface AutoRechargeUpdateBody {
  readonly enabled: boolean;
  readonly threshold?: number;
  readonly amount?: number;
}

interface CronHeaders {
  readonly authorization: string;
}

type CheckoutStatus = 200 | 400 | 401 | 403 | 500 | 503;
type BillingMutationStatus = 200 | 400 | 401 | 403 | 409 | 500 | 503;
type ImageIoStatus = 200 | 202 | 400 | 401 | 402 | 403 | 500 | 502 | 503;
type VideoIoStatus = 200 | 202 | 400 | 401 | 402 | 403 | 500 | 502 | 503 | 504;
type VoiceSpeechStatus = 200 | 400 | 401 | 402 | 403 | 500 | 502 | 503;
type MapsStatus = 200 | 400 | 401 | 402 | 403 | 502 | 503;

function authHeaders(actor: ApiTestUser | null): AuthHeaders {
  return actor ? { authorization: "Bearer clerk-session" } : {};
}

function clerkRole(actor: ApiTestUser): ClerkOrgRole | undefined {
  return actor.orgRole;
}

function clerkUserProfile(actor: ApiTestUser): ClerkUserProfile {
  const emailId = `email_${actor.userId}`;
  return {
    id: actor.userId,
    emailAddresses: [{ id: emailId, emailAddress: actor.email }],
    primaryEmailAddressId: emailId,
    firstName: "BDD",
    lastName: "Actor",
    privateMetadata: {},
  };
}

function clerkOrganizationMemberships(
  actor: ApiTestUser,
): readonly ClerkOrganizationMembership[] {
  if (!actor.orgId) {
    return [];
  }

  return [
    {
      organization: { id: actor.orgId },
      publicUserData: { userId: actor.userId },
      role: actor.orgRole ?? "org:admin",
      createdAt: 1,
    },
  ];
}

function stripeInvoices(value: unknown): readonly StripeInvoice[] {
  if (typeof value !== "object" || value === null || !("data" in value)) {
    return [];
  }

  const { data } = value;
  if (!Array.isArray(data)) {
    return [];
  }

  return data.filter((invoice): invoice is StripeInvoice => {
    return (
      typeof invoice === "object" &&
      invoice !== null &&
      "id" in invoice &&
      "created" in invoice &&
      "amount_paid" in invoice &&
      typeof invoice.id === "string" &&
      typeof invoice.created === "number" &&
      typeof invoice.amount_paid === "number"
    );
  });
}

function cronHeaders(): CronHeaders {
  return { authorization: "Bearer test-cron-secret" };
}

export function createBillingMediaApi(context: TestContext) {
  const routeMocks = createZeroRouteMocks(context);
  mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
  mockListStripeInvoices(async (customerId) => {
    return stripeInvoices(
      await context.mocks.stripe.invoices.list({
        customer: customerId,
        limit: 24,
      }),
    );
  });

  function authenticate(actor: ApiTestUser | null): AuthHeaders {
    if (!actor) {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      return {};
    }

    routeMocks.clerk.session(actor.userId, actor.orgId, clerkRole(actor));
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [clerkUserProfile(actor)],
    });
    const memberships = clerkOrganizationMemberships(actor);
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: memberships,
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: memberships,
      },
    );
    return authHeaders(actor);
  }

  function configureBillingPrices(): void {
    mockEnv(
      "ZERO_PRICE",
      JSON.stringify({
        pro: ["price_bdd_pro"],
        team: ["price_bdd_team"],
        customCredits: ["price_bdd_custom"],
      }),
    );
  }

  function configureCampaign(): void {
    mockEnv(
      "ZERO_ONE_TIME_CAMPAIGN",
      JSON.stringify({
        ZERO100: {
          priceId: "price_bdd_campaign",
          couponId: "coupon_bdd_campaign",
        },
      }),
    );
  }

  function configureGemini(): void {
    mockEnv("GEMINI_API_KEY", "test-gemini-key");
  }

  function configureMapsProvider(): void {
    mockEnv("ZERO_MAPS_GOOGLE_MAPS_TOKEN", "test-google-maps-key");
  }

  return {
    configureBillingPrices,
    configureCampaign,
    configureGemini,
    configureMapsProvider,

    async setupOnboarding(actor: ApiTestUser, body: OnboardingSetupBody) {
      const client = setupApp({ context })(onboardingSetupContract);
      return await accept(
        client.setup({ headers: authenticate(actor), body }),
        [200, 409],
      );
    },

    async readBillingStatus(
      actor: ApiTestUser,
    ): Promise<BillingStatusResponse> {
      const client = setupApp({ context })(zeroBillingStatusContract);
      const response = await accept(
        client.get({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async startCheckout(actor: ApiTestUser, body: CheckoutBody) {
      const client = setupApp({ context })(zeroBillingCheckoutContract);
      return await accept(
        client.create({ headers: authenticate(actor), body }),
        [200],
      );
    },

    async requestCheckout(
      actor: ApiTestUser | null,
      body: CheckoutBody,
      statuses: readonly CheckoutStatus[],
    ) {
      const client = setupApp({ context })(zeroBillingCheckoutContract);
      return await accept(
        client.create({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async completeCheckout(
      actor: ApiTestUser,
      body: { readonly sessionId: string },
      statuses: readonly (200 | 400 | 401 | 403 | 500 | 503)[],
    ) {
      const client = setupApp({ context })(zeroBillingCheckoutContract);
      return await accept(
        client.complete({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async startCreditCheckout(actor: ApiTestUser, body: CreditCheckoutRequest) {
      const client = setupApp({ context })(zeroBillingCreditCheckoutContract);
      return await accept(
        client.create({ headers: authenticate(actor), body }),
        [200],
      );
    },

    async openPortal(actor: ApiTestUser, body: PortalBody) {
      const client = setupApp({ context })(zeroBillingPortalContract);
      return await accept(
        client.create({ headers: authenticate(actor), body }),
        [200],
      );
    },

    async readAutoRecharge(actor: ApiTestUser): Promise<AutoRechargeConfig> {
      const client = setupApp({ context })(zeroBillingAutoRechargeContract);
      const response = await accept(
        client.get({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async updateAutoRecharge(
      actor: ApiTestUser,
      body: AutoRechargeUpdateBody,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      const client = setupApp({ context })(zeroBillingAutoRechargeContract);
      return await accept(
        client.update({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async readInvoices(actor: ApiTestUser): Promise<BillingInvoicesResponse> {
      const client = setupApp({ context })(zeroBillingInvoicesContract);
      const response = await accept(
        client.get({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async requestInvoices(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403 | 500)[],
    ) {
      const client = setupApp({ context })(zeroBillingInvoicesContract);
      return await accept(
        client.get({ headers: authenticate(actor) }),
        statuses,
      );
    },

    async downgradeBilling(
      actor: ApiTestUser,
      body: {
        readonly targetTier: "pro-suspend" | "pro";
        readonly returnUrl?: string;
      },
      statuses: readonly BillingMutationStatus[],
    ) {
      const client = setupApp({ context })(zeroBillingDowngradeContract);
      return await accept(
        client.create({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async restoreBilling(
      actor: ApiTestUser,
      body: { readonly returnUrl?: string },
      statuses: readonly (200 | 401 | 403 | 409 | 500 | 503)[],
    ) {
      const client = setupApp({ context })(zeroBillingRestoreContract);
      return await accept(
        client.create({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async redeemCampaign(
      actor: ApiTestUser,
      campaign: string,
      body: RedeemRequest,
    ) {
      const client = setupApp({ context })(zeroBillingRedeemContract);
      return await accept(
        client.create({
          params: { campaign },
          headers: authenticate(actor),
          body,
        }),
        [200],
      );
    },

    async redeemCode(
      actor: ApiTestUser,
      body: RedeemCodeRequest,
      statuses: readonly (200 | 400 | 401 | 403 | 500 | 503)[],
    ) {
      const client = setupApp({ context })(zeroBillingRedeemCodeContract);
      return await accept(
        client.create({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async readUsage(actor: ApiTestUser) {
      const client = setupApp({ context })(usageContract);
      return await accept(
        client.get({ headers: authenticate(actor), query: {} }),
        [200],
      );
    },

    async readUsageMembers(
      actor: ApiTestUser,
      query: {
        readonly range?: UsageRecordRange;
        readonly tz?: string;
      } = {},
    ) {
      const client = setupApp({ context })(zeroUsageMembersContract);
      return await accept(
        client.get({ headers: authenticate(actor), query }),
        [200],
      );
    },

    async requestUsageMembers(
      actor: ApiTestUser,
      query: {
        readonly range?: UsageRecordRange;
        readonly tz?: string;
      },
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      const client = setupApp({ context })(zeroUsageMembersContract);
      return await accept(
        client.get({ headers: authenticate(actor), query }),
        statuses,
      );
    },

    async readUsageRuns(
      actor: ApiTestUser,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      const client = setupApp({ context })(zeroUsageRunsContract);
      return await accept(
        client.get({
          headers: authenticate(actor),
          query: { page: 1, pageSize: 20 },
        }),
        statuses,
      );
    },

    async readUsageRecord(actor: ApiTestUser) {
      const client = setupApp({ context })(zeroUsageRecordContract);
      return await accept(
        client.get({
          headers: authenticate(actor),
          query: { page: 1, pageSize: 20 },
        }),
        [200],
      );
    },

    async readUsageInsight(
      actor: ApiTestUser,
      query: {
        readonly range: "today" | "yesterday" | "day" | "7d" | "28d" | "30d";
        readonly date?: string;
        readonly groupBy: "source" | "agent";
        readonly tz: string;
      },
      statuses: readonly (200 | 400 | 401 | 500)[],
    ) {
      const client = setupApp({ context })(zeroUsageInsightContract);
      return await accept(
        client.get({ headers: authenticate(actor), query }),
        statuses,
      );
    },

    async readInsights(actor: ApiTestUser): Promise<InsightsResponse> {
      const client = setupApp({ context })(zeroInsightsContract);
      const response = await accept(
        client.get({ headers: authenticate(actor), query: { days: 7 } }),
        [200],
      );
      return response.body;
    },

    async readInsightsRange(
      actor: ApiTestUser,
    ): Promise<InsightsRangeResponse> {
      const client = setupApp({ context })(zeroInsightsRangeContract);
      const response = await accept(
        client.get({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async readModelRankings() {
      const client = setupApp({ context })(modelStatsContract);
      return await accept(
        client.rankings({ query: { period: "week" } }),
        [200],
      );
    },

    async aggregateUsage() {
      const client = setupApp({ context })(cronAggregateUsageContract);
      return await accept(client.aggregate({ headers: cronHeaders() }), [200]);
    },

    async processUsageEvents() {
      const client = setupApp({ context })(cronProcessUsageEventsContract);
      return await accept(client.process({ headers: cronHeaders() }), [200]);
    },

    async aggregateInsights() {
      const client = setupApp({ context })(cronAggregateInsightsContract);
      return await accept(client.aggregate({ headers: cronHeaders() }), [200]);
    },

    async recordSignupAttribution(actor: ApiTestUser) {
      const client = setupApp({ context })(zeroAttributionContract);
      return await accept(
        client.recordSignup({
          headers: authenticate(actor),
          body: {
            attribution: {
              source_type: "paid",
              landing_host: "www.vm0.ai",
              landing_path: "/",
              utm_source: "bdd",
            },
          },
        }),
        [200],
      );
    },

    async updateFeatureSwitches(
      actor: ApiTestUser,
      switches: Readonly<Record<string, boolean>>,
    ) {
      const client = setupApp({ context })(zeroFeatureSwitchesContract);
      return await accept(
        client.update({
          headers: authenticate(actor),
          body: { switches },
        }),
        [200],
      );
    },

    async readVoiceQuota(actor: ApiTestUser) {
      const client = setupApp({ context })(zeroVoiceIoQuotaContract);
      return await accept(client.get({ headers: authenticate(actor) }), [200]);
    },

    async requestVoiceStt(
      actor: ApiTestUser | null,
      formData: FormData,
      statuses: readonly (200 | 400 | 401 | 402 | 403 | 429 | 500)[],
    ) {
      const client = setupApp({ context })(zeroVoiceIoSttContract);
      return await accept(
        client.post({ headers: authenticate(actor), body: formData }),
        statuses,
      );
    },

    async requestAudioTranscriptionV1(
      actor: ApiTestUser,
      statuses: readonly (200 | 400 | 401 | 402 | 403 | 413 | 429 | 500)[],
    ) {
      const client = setupApp({ context })(audioTranscriptionsV1Contract);
      return await accept(
        client.transcribe({
          headers: authenticate(actor),
          body: new Blob([new Uint8Array([0, 0])]),
        }),
        statuses,
      );
    },

    async requestAudioTranscriptionV1WithBearer(
      token: string,
      body: Blob,
      statuses: readonly (200 | 400 | 401 | 402 | 403 | 413 | 429 | 500)[],
      contentType = body.type,
    ) {
      const client = setupApp({ context })(audioTranscriptionsV1Contract);
      return await accept(
        client.transcribe({
          headers: { authorization: `Bearer ${token}` },
          extraHeaders: contentType ? { "content-type": contentType } : {},
          body,
        }),
        statuses,
      );
    },

    async requestVoiceSpeech(
      actor: ApiTestUser | null,
      body: {
        readonly text?: string;
        readonly voice?: string;
        readonly instructions?: string;
      },
      statuses: readonly VoiceSpeechStatus[],
    ) {
      const client = setupApp({ context })(zeroVoiceIoSpeechContract);
      return await accept(
        client.post({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestGenerateImage(
      actor: ApiTestUser | null,
      body: { readonly prompt?: string },
      statuses: readonly (200 | 400 | 401 | 402 | 502 | 503)[],
    ) {
      const client = setupApp({ context })(generateImageContract);
      return await accept(
        client.post({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestImageIoGenerate(
      actor: ApiTestUser | null,
      body: {
        readonly prompt?: string;
        readonly model?: string;
        readonly size?: string;
        readonly quality?: string;
        readonly background?: string;
        readonly outputFormat?: string;
        readonly outputCompression?: number;
        readonly moderation?: string;
        readonly seed?: number;
        readonly safetyTolerance?: string;
        readonly enhancePrompt?: boolean;
        readonly imageUrl?: string;
        readonly imageUrls?: readonly unknown[];
        readonly maskImageUrl?: string;
        readonly inputFidelity?: string;
        readonly imagePromptStrength?: number;
      },
      statuses: readonly ImageIoStatus[],
    ) {
      const client = setupApp({ context })(zeroImageIoGenerateContract);
      return await accept(
        client.post({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestVideoIoGenerate(
      actor: ApiTestUser | null,
      body: {
        readonly prompt?: string;
        readonly model?: string;
        readonly aspectRatio?: string;
        readonly duration?: string;
        readonly resolution?: string;
        readonly generateAudio?: boolean;
        readonly negativePrompt?: string;
        readonly seed?: number;
        readonly autoFix?: boolean;
        readonly safetyTolerance?: string;
        readonly imageUrls?: readonly string[];
        readonly videoUrls?: readonly string[];
        readonly audioUrls?: readonly string[];
        readonly firstFrameImageUrl?: string;
        readonly lastFrameImageUrl?: string;
      },
      statuses: readonly VideoIoStatus[],
    ) {
      const client = setupApp({ context })(zeroVideoIoGenerateContract);
      return await accept(
        client.post({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async readBuiltInGeneration(
      actor: ApiTestUser,
      generationId = randomUUID(),
      statuses: readonly (200 | 401 | 403 | 404 | 500)[] = [200],
    ) {
      const client = setupApp({ context })(zeroBuiltInGenerationContract);
      return await accept(
        client.get({
          params: { generationId },
          headers: authenticate(actor),
        }),
        statuses,
      );
    },

    async requestMapsGeocode(
      actor: ApiTestUser | null,
      body: { readonly address: string; readonly region?: string },
      statuses: readonly MapsStatus[],
    ) {
      const client = setupApp({ context })(zeroMapsContract);
      return await accept(
        client.geocode({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestMapsReverseGeocode(
      actor: ApiTestUser | null,
      body: { readonly lat: number; readonly lng: number },
      statuses: readonly MapsStatus[],
    ) {
      const client = setupApp({ context })(zeroMapsContract);
      return await accept(
        client.reverseGeocode({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestMapsDirections(
      actor: ApiTestUser | null,
      body: {
        readonly origin: string;
        readonly destination: string;
        readonly mode?: "driving" | "walking" | "bicycling" | "transit";
        readonly departureTime?: string;
      },
      statuses: readonly MapsStatus[],
    ) {
      const client = setupApp({ context })(zeroMapsContract);
      return await accept(
        client.directions({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestMapsPlacesSearch(
      actor: ApiTestUser | null,
      body: {
        readonly query: string;
        readonly location?: string;
        readonly radius?: number;
        readonly limit?: number;
        readonly region?: string;
        readonly fields?: "pro" | "enterprise";
      },
      statuses: readonly MapsStatus[],
    ) {
      const client = setupApp({ context })(zeroMapsContract);
      return await accept(
        client.placesSearch({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestMapsPlacesDetails(
      actor: ApiTestUser | null,
      body: {
        readonly placeId: string;
        readonly fields?: "essentials" | "pro" | "enterprise";
      },
      statuses: readonly MapsStatus[],
    ) {
      const client = setupApp({ context })(zeroMapsContract);
      return await accept(
        client.placesDetails({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestBankingAccounts(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 400 | 401 | 403 | 502 | 503)[],
    ) {
      const client = setupApp({ context })(zeroBankingContract);
      return await accept(
        client.accounts({ headers: authenticate(actor), body: {} }),
        statuses,
      );
    },
  };
}
