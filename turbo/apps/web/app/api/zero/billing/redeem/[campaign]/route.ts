import Stripe from "stripe";
import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { zeroBillingRedeemContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import { env } from "../../../../../../src/env";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { getCampaign } from "../../../../../../src/lib/zero/billing/one-time-products";
import { startOrResumeRedemption } from "../../../../../../src/lib/zero/billing/one-time-purchase-service";
import { logger } from "../../../../../../src/lib/shared/logger";

const log = logger("api:zero.billing.redeem");

const router = tsr.router(zeroBillingRedeemContract, {
  create: async ({ params, body, headers }) => {
    initServices();

    const { STRIPE_SECRET_KEY, NEXT_PUBLIC_APP_URL } = env();

    // Pre-auth billing availability check. Runs before requireAuth so the
    // reason surfaces even when Stripe env is broken — operators hit the
    // endpoint without a token and still see `billing_unavailable` instead
    // of a generic 500.
    if (!STRIPE_SECRET_KEY) {
      return {
        status: 200 as const,
        body: {
          status: "error" as const,
          reason: "billing_unavailable" as const,
        },
      };
    }

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    // Open-redirect guard: the client supplies successUrl / cancelUrl and we
    // hand them straight to Stripe. Pin both to the known platform origin so
    // an attacker can't point Stripe back at evil.example.com.
    const appOrigin = new URL(NEXT_PUBLIC_APP_URL).origin;
    if (
      new URL(body.successUrl).origin !== appOrigin ||
      new URL(body.cancelUrl).origin !== appOrigin
    ) {
      return createErrorResponse(
        "BAD_REQUEST",
        "successUrl and cancelUrl must match the platform origin",
      );
    }

    const { org, member } = await resolveOrg(authCtx);
    if (member.role !== "admin") {
      return {
        status: 200 as const,
        body: {
          status: "error" as const,
          reason: "admin_required" as const,
        },
      };
    }

    // Route-level whitelist: unknown campaign keys never reach Stripe. Merges
    // the "unknown" and "misconfigured" cases into one user-facing error since
    // neither is actionable by the viewer.
    if (!getCampaign(params.campaign)) {
      return {
        status: 200 as const,
        body: {
          status: "error" as const,
          reason: "campaign_misconfigured" as const,
        },
      };
    }

    let outcome;
    try {
      outcome = await startOrResumeRedemption({
        orgId: org.orgId,
        campaignKey: params.campaign,
        successUrl: body.successUrl,
        cancelUrl: body.cancelUrl,
      });
    } catch (err) {
      // Any Stripe-side rejection at this point is about the campaign's
      // configuration (coupon deleted / expired / maxed out, price archived,
      // etc.). We've already validated auth/org/env — catching the base
      // StripeError keeps every subclass on the same user-visible state
      // while the full type/code/message lands in the log for on-call.
      if (err instanceof Stripe.errors.StripeError) {
        log.error("redeem: stripe rejected session", {
          orgId: org.orgId,
          campaignKey: params.campaign,
          type: err.type,
          code: err.code,
          message: err.message,
        });
        return {
          status: 200 as const,
          body: {
            status: "error" as const,
            reason: "campaign_misconfigured" as const,
          },
        };
      }
      throw err;
    }

    switch (outcome.kind) {
      case "redirect":
        return {
          status: 200 as const,
          body: {
            status: "ready" as const,
            checkoutUrl: outcome.url,
          },
        };
      case "already_granted":
        return {
          status: 200 as const,
          body: { status: "already_granted" as const },
        };
      case "processing":
        return {
          status: 200 as const,
          body: { status: "processing" as const },
        };
    }
  },
});

const handler = createHandler(zeroBillingRedeemContract, router, {
  routeName: "zero.billing.redeem",
});

export { handler as POST };
