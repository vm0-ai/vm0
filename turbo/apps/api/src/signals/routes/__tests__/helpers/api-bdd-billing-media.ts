import { randomUUID } from "node:crypto";

import type StripeSDK from "stripe";
import { testUsageSettlementContract } from "@vm0/api-contracts/contracts/test-usage-settlement";
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
import { zeroImageIoGenerateContract } from "@vm0/api-contracts/contracts/zero-image-io-generate";
import { zeroMapsContract } from "@vm0/api-contracts/contracts/zero-maps";
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
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import {
  mockListStripeInvoices,
  mockStripeClient,
} from "../../../external/stripe-client";
import { modelStatsContract, modelStatsPublicRoutes } from "../../model-stats";
import { testUsageSettlementRoutes } from "../../test-usage-settlement";
import type { ApiTestUser } from "./api-bdd";
import { createZeroRouteMocks } from "./zero-route-test";
import { zeroAttributionRoutes } from "../../zero-attribution";
import { zeroBankingRoutes } from "../../zero-banking";
import { zeroBillingAutoRechargeRoutes } from "../../zero-billing-auto-recharge";
import { zeroBillingCheckoutRoutes } from "../../zero-billing-checkout";
import { zeroBillingCreditCheckoutRoutes } from "../../zero-billing-credit-checkout";
import { zeroBillingDowngradeRoutes } from "../../zero-billing-downgrade";
import { zeroBillingInvoicesRoutes } from "../../zero-billing-invoices";
import { zeroBillingPortalRoutes } from "../../zero-billing-portal";
import { zeroBillingRedeemRoutes } from "../../zero-billing-redeem";
import { zeroBillingRedeemCodeRoutes } from "../../zero-billing-redeem-code";
import { zeroBillingRestoreRoutes } from "../../zero-billing-restore";
import { zeroBillingStatusRoutes } from "../../zero-billing-status";
import { zeroBuiltInGenerationRoutes } from "../../zero-built-in-generation";
import { zeroFeatureSwitchesRoutes } from "../../zero-feature-switches";
import { zeroImageIoGenerateRoutes } from "../../zero-image-io-generate";
import { zeroMapsRoutes } from "../../zero-maps";
import { zeroUsageMembersRoutes } from "../../zero-usage-members";
import { zeroUsageRecordRoutes } from "../../zero-usage-record";
import { zeroVideoIoGenerateRoutes } from "../../zero-video-io-generate";
import { zeroVoiceIoQuotaRoutes } from "../../zero-voice-io-quota";
import { zeroVoiceIoSpeechRoutes } from "../../zero-voice-io-speech";
import { zeroVoiceIoSttRoutes } from "../../zero-voice-io-stt";

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
  readonly invoice_pdf: string | null;
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

type CheckoutStatus = 200 | 400 | 401 | 403 | 500 | 503;
type BillingMutationStatus = 200 | 400 | 401 | 403 | 409 | 500 | 503;
type ImageIoStatus = 200 | 202 | 400 | 401 | 402 | 403 | 500 | 502 | 503;
type VideoIoStatus = 200 | 202 | 400 | 401 | 402 | 403 | 500 | 502 | 503 | 504;
type VoiceSpeechStatus = 200 | 400 | 401 | 402 | 403 | 500 | 502 | 503;
type MapsStatus = 200 | 400 | 401 | 402 | 403 | 502 | 503;
type OsmLayer = "roads" | "buildings" | "water" | "parks";
type OsmStyle = "standard" | "guide";

interface OsmAreaBody {
  readonly bbox?: {
    readonly west: number;
    readonly south: number;
    readonly east: number;
    readonly north: number;
  };
  readonly center?: {
    readonly lat: number;
    readonly lng: number;
  };
  readonly radiusMeters?: number;
  readonly layers?: readonly OsmLayer[];
}

interface OsmRenderBody extends OsmAreaBody {
  readonly width?: number;
  readonly height?: number;
  readonly style?: OsmStyle;
  readonly title?: string;
  readonly markers?: readonly {
    readonly lat: number;
    readonly lng: number;
    readonly label?: string;
  }[];
}

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

export function createBillingMediaApi(context: TestContext) {
  const routeMocks = createZeroRouteMocks(context);
  mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
  mockListStripeInvoices(async (customerId, created) => {
    return stripeInvoices(
      await context.mocks.stripe.invoices.list({
        customer: customerId,
        limit: created ? 100 : 24,
        ...(created ? { created } : {}),
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
    mockEnv("ZERO_PRICE_PRO", "price_bdd_pro");
    mockEnv("ZERO_PRICE_TEAM", "price_bdd_team");
    mockEnv("ZERO_PRICE_CUSTOM_CREDIT_UNIT", "price_bdd_custom_credit_unit");
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

  function configureMapsProvider(): void {
    mockEnv("ZERO_MAPS_GOOGLE_MAPS_TOKEN", "test-google-maps-key");
  }

  return {
    configureBillingPrices,
    configureCampaign,
    configureMapsProvider,

    async readBillingStatus(
      actor: ApiTestUser,
    ): Promise<BillingStatusResponse> {
      const client = setupApp({ context, routes: zeroBillingStatusRoutes })(
        zeroBillingStatusContract,
      );
      const response = await accept(
        client.get({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async startCheckout(actor: ApiTestUser, body: CheckoutBody) {
      const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
        zeroBillingCheckoutContract,
      );
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
      const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
        zeroBillingCheckoutContract,
      );
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
      const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
        zeroBillingCheckoutContract,
      );
      return await accept(
        client.complete({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async startCreditCheckout(actor: ApiTestUser, body: CreditCheckoutRequest) {
      const client = setupApp({
        context,
        routes: zeroBillingCreditCheckoutRoutes,
      })(zeroBillingCreditCheckoutContract);
      return await accept(
        client.create({ headers: authenticate(actor), body }),
        [200],
      );
    },

    async requestCreditCheckout(
      actor: ApiTestUser,
      body: CreditCheckoutRequest,
      statuses: readonly CheckoutStatus[],
    ) {
      const client = setupApp({
        context,
        routes: zeroBillingCreditCheckoutRoutes,
      })(zeroBillingCreditCheckoutContract);
      return await accept(
        client.create({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async openPortal(actor: ApiTestUser, body: PortalBody) {
      const client = setupApp({ context, routes: zeroBillingPortalRoutes })(
        zeroBillingPortalContract,
      );
      return await accept(
        client.create({ headers: authenticate(actor), body }),
        [200],
      );
    },

    async readAutoRecharge(actor: ApiTestUser): Promise<AutoRechargeConfig> {
      const client = setupApp({
        context,
        routes: zeroBillingAutoRechargeRoutes,
      })(zeroBillingAutoRechargeContract);
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
      const client = setupApp({
        context,
        routes: zeroBillingAutoRechargeRoutes,
      })(zeroBillingAutoRechargeContract);
      return await accept(
        client.update({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async readInvoices(actor: ApiTestUser): Promise<BillingInvoicesResponse> {
      const client = setupApp({ context, routes: zeroBillingInvoicesRoutes })(
        zeroBillingInvoicesContract,
      );
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
      const client = setupApp({ context, routes: zeroBillingInvoicesRoutes })(
        zeroBillingInvoicesContract,
      );
      return await accept(
        client.get({ headers: authenticate(actor) }),
        statuses,
      );
    },

    async downgradeBilling(
      actor: ApiTestUser,
      body: {
        readonly targetTier: "limited-free-1" | "pro-suspend" | "pro";
        readonly returnUrl?: string;
      },
      statuses: readonly BillingMutationStatus[],
    ) {
      const client = setupApp({ context, routes: zeroBillingDowngradeRoutes })(
        zeroBillingDowngradeContract,
      );
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
      const client = setupApp({ context, routes: zeroBillingRestoreRoutes })(
        zeroBillingRestoreContract,
      );
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
      const client = setupApp({ context, routes: zeroBillingRedeemRoutes })(
        zeroBillingRedeemContract,
      );
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
      const client = setupApp({ context, routes: zeroBillingRedeemCodeRoutes })(
        zeroBillingRedeemCodeContract,
      );
      return await accept(
        client.create({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async readUsageMembers(
      actor: ApiTestUser,
      query: {
        readonly range?: UsageRecordRange;
        readonly tz?: string;
      } = {},
    ) {
      const client = setupApp({ context, routes: zeroUsageMembersRoutes })(
        zeroUsageMembersContract,
      );
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
      const client = setupApp({ context, routes: zeroUsageMembersRoutes })(
        zeroUsageMembersContract,
      );
      return await accept(
        client.get({ headers: authenticate(actor), query }),
        statuses,
      );
    },

    async readUsageRecord(actor: ApiTestUser) {
      const client = setupApp({ context, routes: zeroUsageRecordRoutes })(
        zeroUsageRecordContract,
      );
      return await accept(
        client.get({
          headers: authenticate(actor),
          query: {
            page: 1,
            pageSize: 20,
            scope: "mine",
            range: "24h",
            tz: "UTC",
          },
        }),
        [200],
      );
    },

    async readModelRankings() {
      const client = setupApp({ context, routes: modelStatsPublicRoutes })(
        modelStatsContract,
      );
      return await accept(
        client.rankings({ query: { period: "week" } }),
        [200],
      );
    },

    async processOrgUsageEvents(actor: ApiTestUser) {
      if (!actor.orgId) {
        throw new Error("Cannot process usage without an organization");
      }
      const client = setupApp({
        context,
        routes: testUsageSettlementRoutes,
      })(testUsageSettlementContract);
      return await accept(
        client.process({ body: { org_id: actor.orgId } }),
        [200],
      );
    },

    async recordSignupAttribution(actor: ApiTestUser) {
      const client = setupApp({ context, routes: zeroAttributionRoutes })(
        zeroAttributionContract,
      );
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
      const client = setupApp({ context, routes: zeroFeatureSwitchesRoutes })(
        zeroFeatureSwitchesContract,
      );
      return await accept(
        client.update({
          headers: authenticate(actor),
          body: { switches },
        }),
        [200],
      );
    },

    async readVoiceQuota(actor: ApiTestUser) {
      const client = setupApp({ context, routes: zeroVoiceIoQuotaRoutes })(
        zeroVoiceIoQuotaContract,
      );
      return await accept(client.get({ headers: authenticate(actor) }), [200]);
    },

    async requestVoiceStt(
      actor: ApiTestUser | null,
      formData: FormData,
      statuses: readonly (200 | 400 | 401 | 402 | 403 | 429 | 500)[],
    ) {
      const client = setupApp({ context, routes: zeroVoiceIoSttRoutes })(
        zeroVoiceIoSttContract,
      );
      return await accept(
        client.post({ headers: authenticate(actor), body: formData }),
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
      const client = setupApp({ context, routes: zeroVoiceIoSpeechRoutes })(
        zeroVoiceIoSpeechContract,
      );
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
        readonly imageUrls?: readonly string[];
        readonly maskImageUrl?: string;
        readonly inputFidelity?: string;
        readonly imagePromptStrength?: number;
      },
      statuses: readonly ImageIoStatus[],
    ) {
      const client = setupApp({ context, routes: zeroImageIoGenerateRoutes })(
        zeroImageIoGenerateContract,
      );
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
      const client = setupApp({ context, routes: zeroVideoIoGenerateRoutes })(
        zeroVideoIoGenerateContract,
      );
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
      const client = setupApp({ context, routes: zeroBuiltInGenerationRoutes })(
        zeroBuiltInGenerationContract,
      );
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
      const client = setupApp({ context, routes: zeroMapsRoutes })(
        zeroMapsContract,
      );
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
      const client = setupApp({ context, routes: zeroMapsRoutes })(
        zeroMapsContract,
      );
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
      const client = setupApp({ context, routes: zeroMapsRoutes })(
        zeroMapsContract,
      );
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
      const client = setupApp({ context, routes: zeroMapsRoutes })(
        zeroMapsContract,
      );
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
      const client = setupApp({ context, routes: zeroMapsRoutes })(
        zeroMapsContract,
      );
      return await accept(
        client.placesDetails({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestMapsOsmDownload(
      actor: ApiTestUser | null,
      body: OsmAreaBody,
      statuses: readonly MapsStatus[],
    ) {
      const client = setupApp({ context, routes: zeroMapsRoutes })(
        zeroMapsContract,
      );
      return await accept(
        client.osmDownload({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestMapsOsmRender(
      actor: ApiTestUser | null,
      body: OsmRenderBody,
      statuses: readonly MapsStatus[],
    ) {
      const client = setupApp({ context, routes: zeroMapsRoutes })(
        zeroMapsContract,
      );
      return await accept(
        client.osmRender({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestBankingAccounts(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 400 | 401 | 403 | 502 | 503)[],
    ) {
      const client = setupApp({ context, routes: zeroBankingRoutes })(
        zeroBankingContract,
      );
      return await accept(
        client.accounts({ headers: authenticate(actor), body: {} }),
        statuses,
      );
    },
  };
}
