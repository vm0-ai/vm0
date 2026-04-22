import { auth } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";
import Stripe from "stripe";
import { initServices } from "../../../src/lib/init-services";
import { env } from "../../../src/env";
import { getCampaign } from "../../../src/lib/zero/billing/one-time-products";
import { startOrResumeRedemption } from "../../../src/lib/zero/billing/one-time-purchase-service";
import { logger } from "../../../src/lib/shared/logger";

const log = logger("route:redeem");

/**
 * GET /redeem/[campaign]
 *
 * One-click campaign redemption: authenticated org admin is redirected to a
 * Stripe Checkout session tied to the campaign (price + coupon). Guest users
 * are bounced through /sign-in first so they land back here after login.
 *
 * The route is the first of three defense layers against credit inflation:
 *
 *  1. Whitelist check (this handler): `campaign` must be resolvable via
 *     {@link getCampaign} (i.e. both `CAMPAIGN_POLICY` and the env-backed
 *     Stripe config must have it) — blocks URL tampering.
 *  2. Pre-checkout dedup: `org_promo_redemption` unique index serializes
 *     concurrent admins of the same org to a single Stripe session.
 *  3. Webhook idempotency: `credit_expires_record.stripe_invoice_id`
 *     conflict clause prevents double-grant on Stripe webhook retries.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ campaign: string }> },
): Promise<NextResponse> {
  initServices();
  const { STRIPE_SECRET_KEY, NEXT_PUBLIC_APP_URL } = env();
  // Use the live request origin for /sign-in (same web host) but the platform
  // app URL for the error page (lives at app.<domain>, not www.<domain>).
  const origin = req.nextUrl.origin;
  const errorPage = (reason: string) => {
    return new URL(`/redeem/error?reason=${reason}`, NEXT_PUBLIC_APP_URL);
  };
  const statusPage = (state: string) => {
    return new URL(`/redeem/status?state=${state}`, NEXT_PUBLIC_APP_URL);
  };

  try {
    if (!STRIPE_SECRET_KEY) {
      return NextResponse.redirect(errorPage("billing_unavailable"));
    }

    const { campaign: campaignKey } = await ctx.params;

    // Layer 1: route-level whitelist. Reject before even calling Stripe so an
    // attacker can't use the endpoint to enumerate campaigns or kick off
    // checkout for an unintended price/coupon combo.
    if (!getCampaign(campaignKey)) {
      return new NextResponse("Not Found", { status: 404 });
    }

    const { userId, orgId, orgRole } = await auth();

    // Preserve the full current URL (path + query) so Clerk's post-flow
    // redirect drops the user right back at this handler.
    const redirectUrl = req.nextUrl.pathname + req.nextUrl.search;

    if (!userId) {
      const target = new URL("/sign-in", origin);
      target.searchParams.set("redirect_url", redirectUrl);
      return NextResponse.redirect(target);
    }
    if (!orgId) {
      // Let Clerk's org-selection task handle org choice; on completion it
      // brings the user back to the redemption URL.
      const target = new URL("/sign-in/tasks/choose-organization", origin);
      target.searchParams.set("redirect_url", redirectUrl);
      return NextResponse.redirect(target);
    }
    if (orgRole !== "org:admin") {
      return NextResponse.redirect(errorPage("admin_required"));
    }

    // Stripe success/cancel always return to the platform app, not the web
    // origin. Credits are visible in the app dashboard, and using the env
    // URL means devs hitting localhost:3000/redeem/... still end up on the
    // real platform after payment instead of bouncing to a local marketing
    // page.
    // success → status page so users see a branded confirmation card
    // (matches what they see on repeat clicks via startOrResumeRedemption).
    const appHome = new URL("/", NEXT_PUBLIC_APP_URL).toString();
    let outcome;
    try {
      outcome = await startOrResumeRedemption({
        orgId,
        campaignKey,
        successUrl: statusPage("already_redeemed").toString(),
        cancelUrl: appHome,
      });
    } catch (err) {
      // Config drift: env points at a priceId/couponId Stripe doesn't have.
      // Redirect instead of 500ing so admin users see a readable signal.
      if (
        err instanceof Stripe.errors.StripeInvalidRequestError &&
        err.code === "resource_missing"
      ) {
        log.error("campaign misconfigured — Stripe resource missing", {
          orgId,
          campaignKey,
          param: err.param,
          message: err.message,
        });
        return NextResponse.redirect(errorPage("campaign_misconfigured"));
      }
      throw err;
    }

    switch (outcome.kind) {
      case "redirect":
        log.info("one_time_purchase redirecting to Stripe", {
          orgId,
          campaignKey,
        });
        return NextResponse.redirect(outcome.url);
      case "already_granted":
        return NextResponse.redirect(statusPage("already_redeemed"));
      case "processing":
        return NextResponse.redirect(statusPage("processing"));
    }
  } catch (err) {
    // Outer safety net: anything unexpected (DB down, Stripe 5xx, auth blip,
    // etc.) should still surface as the branded error page, not a bare 500.
    // on-call still gets full detail via the log + Sentry hook.
    log.error("redeem route unexpected error", {
      err: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return NextResponse.redirect(errorPage("unknown"));
  }
}
