import { auth } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";
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
  const { STRIPE_SECRET_KEY } = env();
  // Use the live request origin instead of a NEXT_PUBLIC_ env var so redirects
  // follow the host the user actually hit (bad smell #6 — NEXT_PUBLIC_ vars are
  // bundled into client code and should not be read server-side).
  const origin = req.nextUrl.origin;
  if (!STRIPE_SECRET_KEY) {
    return NextResponse.redirect(
      new URL("/?error=billing_unavailable", origin),
    );
  }

  const { campaign: campaignKey } = await ctx.params;

  // Layer 1: route-level whitelist. Reject before even calling Stripe so an
  // attacker can't use the endpoint to enumerate campaigns or kick off
  // checkout for an unintended price/coupon combo.
  if (!getCampaign(campaignKey)) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    // Preserve the full current URL (path + query) so Clerk's post-login
    // redirect drops the user right back at this handler.
    const redirectUrl = req.nextUrl.pathname + req.nextUrl.search;
    const target = new URL("/sign-in", origin);
    target.searchParams.set("redirect_url", redirectUrl);
    return NextResponse.redirect(target);
  }
  if (!orgId) {
    return NextResponse.redirect(new URL("/?error=no_active_org", origin));
  }
  if (orgRole !== "org:admin") {
    return NextResponse.redirect(new URL("/?error=admin_required", origin));
  }

  const homeUrl = new URL("/", origin).toString();
  const outcome = await startOrResumeRedemption({
    orgId,
    campaignKey,
    successUrl: homeUrl,
    cancelUrl: homeUrl,
  });

  switch (outcome.kind) {
    case "redirect":
      log.info("one_time_purchase redirecting to Stripe", {
        orgId,
        campaignKey,
      });
      return NextResponse.redirect(outcome.url);
    case "already_granted":
      return NextResponse.redirect(new URL("/?promo=already_redeemed", origin));
    case "processing":
      return NextResponse.redirect(new URL("/?promo=processing", origin));
  }
}
