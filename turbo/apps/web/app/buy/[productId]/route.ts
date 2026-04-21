import { auth } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";
import { initServices } from "../../../src/lib/init-services";
import { env } from "../../../src/env";
import {
  getOneTimeProduct,
  isAllowedPromoCode,
} from "../../../src/lib/zero/billing/one-time-products";
import { startOrResumeRedemption } from "../../../src/lib/zero/billing/one-time-purchase-service";
import { logger } from "../../../src/lib/shared/logger";

const log = logger("route:buy");

/**
 * GET /buy/[productId]?promo=<couponId>
 *
 * One-click promo redemption: authenticated org admin is redirected to a
 * Stripe Checkout session tied to (product, coupon). Guest users are bounced
 * through /sign-in first so they land back here after login.
 *
 * The route is the first of three defense layers against credit inflation:
 *
 *  1. Whitelist check (this handler): `productId` + `promoCode` must be
 *     in `ONE_TIME_PRODUCTS`, otherwise 404 — blocks URL tampering.
 *  2. Pre-checkout dedup: `org_promo_redemption` unique index serializes
 *     concurrent admins of the same org to a single Stripe session.
 *  3. Webhook idempotency: `credit_expires_record.stripe_invoice_id`
 *     conflict clause prevents double-grant on Stripe webhook retries.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ productId: string }> },
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

  const { productId } = await ctx.params;
  const promoCode = req.nextUrl.searchParams.get("promo") ?? "";

  // Layer 1: route-level whitelist. Reject before even calling Stripe so an
  // attacker can't use the endpoint to enumerate product IDs or kick off
  // checkout for an unintended product/coupon combo.
  if (
    !getOneTimeProduct(productId) ||
    !isAllowedPromoCode(productId, promoCode)
  ) {
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
    productId,
    promoCode,
    successUrl: homeUrl,
    cancelUrl: homeUrl,
  });

  switch (outcome.kind) {
    case "redirect":
      log.info("one_time_purchase redirecting to Stripe", {
        orgId,
        productId,
        promoCode,
      });
      return NextResponse.redirect(outcome.url);
    case "already_granted":
      return NextResponse.redirect(new URL("/?promo=already_redeemed", origin));
    case "processing":
      return NextResponse.redirect(new URL("/?promo=processing", origin));
  }
}
