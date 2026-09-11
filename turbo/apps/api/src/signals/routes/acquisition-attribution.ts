import {
  MARKETING_PRIVACY_RECEIPT_KEY,
  IMPACT_PRIVACY_RECEIPT_KEY,
  type PrivacyCaptureContext,
} from "@okouai/api-contracts/contracts/marketing-privacy";
import { captureMarketingPrivacy$ } from "../services/marketing-privacy.service";
import {
  legacyGoogleAdsAttribution,
  normalizeGoogleAdsAttribution,
} from "@okouai/core/google-ads-attribution";
import { command } from "ccstate";
import {
  googleAdsAccountForAttribution,
  GOOGLE_ADS_ADSMARCH_ACCOUNT_ID,
} from "@okouai/core/google-ads-account";
import {
  acquisitionAttributionContract,
  type AdAttributionMetadata,
} from "@okouai/api-contracts/contracts/acquisition-attribution";

import {
  IMPACT_ATTRIBUTION_METADATA_KEY,
  parseImpactAttribution,
} from "@okouai/api-contracts/contracts/impact-attribution";

import { authContext$ } from "../auth/auth-context";
import { request$ } from "../context/hono";
import { userPrivacyChoice$ } from "../services/privacy-choices.service";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { clerk$ } from "../external/clerk";
import { clerkAttributionDisabled } from "../../lib/clerk-attribution";
import { nowDate } from "../../lib/time";
import {
  googleAdsAccountForUser$,
  parseStoredSignupAttribution,
  persistOrgAcquisitionAttribution$,
} from "../services/acquisition-attribution.service";
import { googleAdsConversionMilestonesForUser$ } from "../services/google-ads-conversion-milestones.service";
import { syncImpactStripeCustomer$ } from "../services/impact-attribution.service";
import type { RouteEntry } from "../route-entry";

const SIGNUP_ATTRIBUTION_KEY = "signup_attribution";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const recordSignupBody$ = bodyResultOf(
  acquisitionAttributionContract.recordSignup,
);

const resolveGoogleAdsAccountInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(
      bodyResultOf(acquisitionAttributionContract.resolveGoogleAdsAccount),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const googleAdsAccountId = await set(
      googleAdsAccountForUser$,
      get(authContext$).userId,
      body.data.attribution,
      signal,
    );
    return { status: 200 as const, body: { googleAdsAccountId } };
  },
);

const googleAdsMilestonesInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const googleAdsAccountId = await set(
      googleAdsAccountForUser$,
      auth.userId,
      undefined,
      signal,
    );
    if (googleAdsAccountId !== GOOGLE_ADS_ADSMARCH_ACCOUNT_ID) {
      return {
        status: 200 as const,
        body: { milestones: [], googleAdsAccountId },
      };
    }
    const milestones = await set(
      googleAdsConversionMilestonesForUser$,
      auth.userId,
      signal,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body: { milestones, googleAdsAccountId } };
  },
);

const recordSignupImpact$ = command(
  async (
    { get, set },
    args: {
      readonly impactAttribution: unknown;
      readonly privacyContext?: PrivacyCaptureContext;
      readonly privateMetadata: Record<string, unknown>;
    },
    signal: AbortSignal,
  ) => {
    const auth = get(authContext$);
    const clerk = get(clerk$);
    const privateMetadata = { ...args.privateMetadata };
    const impact = parseImpactAttribution(
      args.impactAttribution,
      nowDate().getTime(),
    );
    const previousImpact = parseImpactAttribution(
      privateMetadata[IMPACT_ATTRIBUTION_METADATA_KEY],
      nowDate().getTime(),
    );
    if (
      impact &&
      (!previousImpact || impact.capturedAt > previousImpact.capturedAt)
    ) {
      const impactReceipt =
        args.privacyContext &&
        new Date(impact.capturedAt) >= new Date(args.privacyContext.capturedAt)
          ? await set(
              captureMarketingPrivacy$,
              {
                userId: auth.userId,
                context: args.privacyContext,
              },
              signal,
            )
          : null;
      signal.throwIfAborted();
      await clerk.users.updateUserMetadata(auth.userId, {
        privateMetadata: {
          [IMPACT_ATTRIBUTION_METADATA_KEY]: impact,
          ...(impactReceipt || privateMetadata[IMPACT_PRIVACY_RECEIPT_KEY]
            ? { [IMPACT_PRIVACY_RECEIPT_KEY]: impactReceipt }
            : {}),
        },
      });
      signal.throwIfAborted();
      privateMetadata[IMPACT_ATTRIBUTION_METADATA_KEY] = impact;
      privateMetadata[IMPACT_PRIVACY_RECEIPT_KEY] = impactReceipt;
    }
    const currentImpact = parseImpactAttribution(
      privateMetadata[IMPACT_ATTRIBUTION_METADATA_KEY],
      nowDate().getTime(),
    );
    if (impact && currentImpact) {
      await set(
        syncImpactStripeCustomer$,
        {
          impact_click_id: currentImpact.clickId,
          impact_click_at: currentImpact.capturedAt,
          ...(typeof privateMetadata[IMPACT_PRIVACY_RECEIPT_KEY] === "string"
            ? {
                impact_privacy_receipt:
                  privateMetadata[IMPACT_PRIVACY_RECEIPT_KEY],
                impact_privacy_user_id: auth.userId,
              }
            : {}),
        },
        signal,
      );
    }
    return privateMetadata;
  },
);

const recordSignupInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const bodyResult = await get(recordSignupBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    if (get(request$).header("Sec-GPC") === "1") {
      await set(userPrivacyChoice$, { userId: auth.userId, gpc: true }, signal);
      signal.throwIfAborted();
    }

    if (clerkAttributionDisabled()) {
      return {
        status: 200 as const,
        body: { recorded: false, googleAdsAccountId: null },
      };
    }

    const clerk = get(clerk$);
    const users = await clerk.users.getUserList({
      userId: [auth.userId],
      limit: 1,
    });
    signal.throwIfAborted();

    const user = users.data.find((candidate) => {
      return candidate.id === auth.userId;
    });
    if (!user) {
      throw new Error(`No Clerk user found for user ${auth.userId}`);
    }

    const privateMetadata = isRecord(user.privateMetadata)
      ? user.privateMetadata
      : {};
    const enrichedMetadata = await set(
      recordSignupImpact$,
      {
        impactAttribution: bodyResult.data.impactAttribution,
        privacyContext: bodyResult.data.privacyContext,
        privateMetadata,
      },
      signal,
    );
    signal.throwIfAborted();
    const existingAttribution = parseStoredSignupAttribution(
      enrichedMetadata[SIGNUP_ATTRIBUTION_KEY],
    );
    if (
      Object.prototype.hasOwnProperty.call(
        enrichedMetadata,
        SIGNUP_ATTRIBUTION_KEY,
      )
    ) {
      if (auth.orgId && existingAttribution) {
        await set(
          persistOrgAcquisitionAttribution$,
          {
            orgId: auth.orgId,
            attribution: existingAttribution,
          },
          signal,
        );
      }
      return {
        status: 200 as const,
        body: {
          recorded: false,
          googleAdsAccountId:
            googleAdsAccountForAttribution(existingAttribution),
        },
      };
    }

    const attribution: AdAttributionMetadata = normalizeGoogleAdsAttribution(
      bodyResult.data.attribution,
    );
    if (Object.keys(attribution).length === 0) {
      return {
        status: 200 as const,
        body: { recorded: false, googleAdsAccountId: null },
      };
    }
    const privacyReceipt = await set(
      captureMarketingPrivacy$,
      { userId: auth.userId, context: bodyResult.data.privacyContext },
      signal,
    );
    signal.throwIfAborted();
    await clerk.users.updateUserMetadata(auth.userId, {
      privateMetadata: {
        ...enrichedMetadata,
        ...(privacyReceipt
          ? { [MARKETING_PRIVACY_RECEIPT_KEY]: privacyReceipt }
          : {}),
        [SIGNUP_ATTRIBUTION_KEY]: {
          ...legacyGoogleAdsAttribution(attribution),
          recorded_at: nowDate().toISOString(),
        },
      },
    });
    signal.throwIfAborted();

    if (auth.orgId) {
      await set(
        persistOrgAcquisitionAttribution$,
        { orgId: auth.orgId, attribution },
        signal,
      );
    }

    return {
      status: 200 as const,
      body: {
        recorded: true,
        ...(bodyResult.data.privacyContext ? { privacyReceipt } : {}),
        googleAdsAccountId: googleAdsAccountForAttribution(attribution),
      },
    };
  },
);

export const acquisitionAttributionRoutes: readonly RouteEntry[] = [
  {
    route: acquisitionAttributionContract.resolveGoogleAdsAccount,
    handler: authRoute({ accept: ["session"] }, resolveGoogleAdsAccountInner$),
  },
  {
    route: acquisitionAttributionContract.googleAdsMilestones,
    handler: authRoute({ accept: ["session"] }, googleAdsMilestonesInner$),
  },
  {
    route: acquisitionAttributionContract.recordSignup,
    handler: authRoute({ accept: ["session"] }, recordSignupInner$),
  },
];
