import { command } from "ccstate";
import { zeroBillingRedeemContract } from "@vm0/api-contracts/contracts/zero-billing";

import { optionalEnv } from "../../lib/env";
import { billingRedirectAllowed } from "../../lib/billing-redirect";
import { badRequestMessage } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { getCampaign } from "../services/one-time-products";
import { startOrResumeRedemption$ } from "../services/zero-billing-redeem.service";
import type { RouteEntry } from "../route";

const billingUnavailable = Object.freeze({
  status: 200 as const,
  body: Object.freeze({
    status: "error" as const,
    reason: "billing_unavailable" as const,
  }),
});

const adminRequired = Object.freeze({
  status: 200 as const,
  body: Object.freeze({
    status: "error" as const,
    reason: "admin_required" as const,
  }),
});

const campaignMisconfigured = Object.freeze({
  status: 200 as const,
  body: Object.freeze({
    status: "error" as const,
    reason: "campaign_misconfigured" as const,
  }),
});

const redeemAuthed$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroBillingRedeemContract.create));
  const bodyResult = await get(bodyResultOf(zeroBillingRedeemContract.create));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const { successUrl, cancelUrl } = bodyResult.data;

  // Open-redirect guard: client supplies successUrl/cancelUrl and they flow
  // straight to Stripe. Pin both to vm0-owned hosts so an attacker can't
  // redirect Stripe back to evil.example.com.
  if (
    !billingRedirectAllowed(successUrl) ||
    !billingRedirectAllowed(cancelUrl)
  ) {
    return badRequestMessage(
      "successUrl and cancelUrl must match the platform origin",
    );
  }

  if (auth.orgRole !== "admin") {
    return adminRequired;
  }

  // Route-level whitelist: unknown campaign keys never reach Stripe.
  if (!getCampaign(params.campaign)) {
    return campaignMisconfigured;
  }

  const result = await set(
    startOrResumeRedemption$,
    {
      orgId: auth.orgId,
      campaignKey: params.campaign,
      successUrl,
      cancelUrl,
    },
    signal,
  );
  signal.throwIfAborted();

  switch (result.kind) {
    case "stripe_error": {
      return campaignMisconfigured;
    }
    case "redirect": {
      return {
        status: 200 as const,
        body: {
          status: "ready" as const,
          checkoutUrl: result.url,
        },
      };
    }
    case "already_granted": {
      return {
        status: 200 as const,
        body: { status: "already_granted" as const },
      };
    }
    case "processing": {
      return {
        status: 200 as const,
        body: { status: "processing" as const },
      };
    }
  }
});

// Outer command wraps authRoute so the pre-auth Stripe availability check
// runs before authentication. The web route returns `billing_unavailable`
// (HTTP 200) for unauthenticated callers when STRIPE_SECRET_KEY is missing —
// authRoute always runs auth first, so we cannot put the check inside it.
const redeem$ = command(async ({ set }, signal: AbortSignal) => {
  if (!optionalEnv("STRIPE_SECRET_KEY")) {
    return billingUnavailable;
  }
  return await set(
    authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      redeemAuthed$,
    ),
    signal,
  );
});

export const zeroBillingRedeemRoutes: readonly RouteEntry[] = [
  {
    route: zeroBillingRedeemContract.create,
    handler: redeem$,
  },
];
