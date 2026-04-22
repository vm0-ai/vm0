import { and, eq } from "drizzle-orm";
import Stripe from "stripe";
import { orgPromoRedemption } from "../../../db/schema/org-promo-redemption";
import { creditExpiresRecord } from "../../../db/schema/credit-expires-record";
import { createOneTimeCheckoutSession } from "./billing-service";
import { getCampaign } from "./one-time-products";
import { getStripe } from "../stripe";
import { logger } from "../../shared/logger";

const log = logger("one-time-purchase");

/**
 * The outcome of a `POST /api/zero/billing/redeem/:campaign` attempt.
 *
 * - `redirect` — send the user to Stripe Checkout at `url`.
 * - `already_granted` — credits are already in the org ledger; the user has
 *   nothing to pay.
 * - `processing` — Stripe accepted the payment but the webhook hasn't
 *   persisted the grant yet; the user should refresh shortly.
 */
type RedemptionOutcome =
  | { kind: "redirect"; url: string }
  | { kind: "already_granted" }
  | { kind: "processing" };

interface RedemptionParams {
  orgId: string;
  campaignKey: string;
  successUrl: string;
  cancelUrl: string;
}

/**
 * Claim-or-resume the Stripe Checkout session for (org, campaign).
 *
 * Only one session per (org, campaign) can exist thanks to the unique index
 * on `org_promo_redemption`. If we can claim the row we create a fresh Stripe
 * session; otherwise we fall through to resume logic that respects whether
 * the existing session is still open, already completed, or expired.
 */
export async function startOrResumeRedemption(
  params: RedemptionParams,
): Promise<RedemptionOutcome> {
  const db = globalThis.services.db;

  // Fast path: row already exists — go straight to resume logic without
  // paying for a throwaway Stripe session.
  const existing = await selectRedemption(params);
  if (existing) {
    return resumeExisting(params, existing.stripeSessionId);
  }

  // Claim the row by creating a Stripe session and inserting in one go.
  // A concurrent caller may have also reached here; the UNIQUE index
  // serializes us so only one insert wins.
  const session = await createOneTimeCheckoutSession(params);
  const inserted = await db
    .insert(orgPromoRedemption)
    .values({
      orgId: params.orgId,
      campaignKey: params.campaignKey,
      stripeSessionId: session.sessionId,
    })
    .onConflictDoNothing()
    .returning({ stripeSessionId: orgPromoRedemption.stripeSessionId });

  if (inserted.length > 0) {
    return { kind: "redirect", url: session.url };
  }

  // Lost the race — some other caller claimed the row. Expire the throwaway
  // Stripe session we just created so it doesn't linger for 24h as dashboard
  // noise, then resume against the winner's session.
  const stripe = getStripe();
  await stripe.checkout.sessions.expire(session.sessionId);

  // The winning transaction has committed (our insert saw the conflict), so
  // the row MUST be visible. If it's not, something is wrong at the DB
  // layer — surface an operator-friendly message and let on-call debug.
  const winner = await selectRedemption(params);
  if (!winner) {
    log.error("one_time_purchase race inconsistency", {
      orgId: params.orgId,
      campaignKey: params.campaignKey,
    });
    throw new Error(
      "Redemption state is temporarily inconsistent; please retry in a moment",
    );
  }
  return resumeExisting(params, winner.stripeSessionId);
}

async function selectRedemption(
  params: RedemptionParams,
): Promise<{ stripeSessionId: string } | undefined> {
  const db = globalThis.services.db;
  const [row] = await db
    .select({ stripeSessionId: orgPromoRedemption.stripeSessionId })
    .from(orgPromoRedemption)
    .where(
      and(
        eq(orgPromoRedemption.orgId, params.orgId),
        eq(orgPromoRedemption.campaignKey, params.campaignKey),
      ),
    )
    .limit(1);
  return row;
}

async function resumeExisting(
  params: RedemptionParams,
  stripeSessionId: string,
): Promise<RedemptionOutcome> {
  const db = globalThis.services.db;

  // Credits already landed? Source of truth is the credit ledger, not the
  // Stripe session — the webhook may have already processed.
  const [granted] = await db
    .select({ id: creditExpiresRecord.id })
    .from(creditExpiresRecord)
    .where(
      and(
        eq(creditExpiresRecord.orgId, params.orgId),
        eq(creditExpiresRecord.stripeInvoiceId, stripeSessionId),
      ),
    )
    .limit(1);
  if (granted) {
    return { kind: "already_granted" };
  }

  const stripe = getStripe();
  const session = await stripe.checkout.sessions.retrieve(stripeSessionId);

  if (session.status === "open" && session.url) {
    // Re-validate the underlying coupon before handing back the cached
    // session URL. An admin may have deleted the coupon, let it pass its
    // `redeem_by`, or hit `max_redemptions` after the session was created —
    // Stripe would silently keep the session "open" for 24h and only block
    // at payment time, which is a lousy UX. On failure we expire the
    // session, drop the dedup row, and propagate `resource_missing` so the
    // route lands on campaign_misconfigured.
    await ensureCampaignStillAvailable(params, stripeSessionId);
    return { kind: "redirect", url: session.url };
  }
  if (session.status === "complete") {
    return { kind: "processing" };
  }

  // status is "expired" (or null/unknown) — rotate the row to a fresh session
  // so the user can try again.
  const fresh = await createOneTimeCheckoutSession(params);
  await db
    .update(orgPromoRedemption)
    .set({ stripeSessionId: fresh.sessionId, updatedAt: new Date() })
    .where(
      and(
        eq(orgPromoRedemption.orgId, params.orgId),
        eq(orgPromoRedemption.campaignKey, params.campaignKey),
      ),
    );
  log.info("one_time_purchase session refreshed", {
    orgId: params.orgId,
    campaignKey: params.campaignKey,
    oldSessionId: stripeSessionId,
    newSessionId: fresh.sessionId,
  });
  return { kind: "redirect", url: fresh.url };
}

/**
 * Throw a `resource_missing` StripeInvalidRequestError if the campaign's
 * coupon or price isn't usable right now. Covers:
 *   - coupon deleted in Stripe (retrieve → 404)
 *   - coupon has `valid: false` (computed from `redeem_by`,
 *     `max_redemptions`, or manual disable)
 *   - price deleted/unrecognised (retrieve → 404)
 *   - price archived (`active: false`)
 *
 * `checkout.sessions.create` validates both resources at session creation,
 * but the cached open session we're about to reuse was minted some time
 * ago. Stripe doesn't revalidate on retrieve, so drift between then and
 * now has to be caught here. On failure we expire the stripe session,
 * drop the dedup row, and let the outer route land the user on
 * campaign_misconfigured.
 */
async function ensureCampaignStillAvailable(
  params: RedemptionParams,
  stripeSessionId: string,
): Promise<void> {
  const campaign = getCampaign(params.campaignKey);
  if (!campaign) {
    // Route already 404s if getCampaign is undefined — if we got here, env
    // drifted mid-request. Surfacing as misconfigured is fine.
    await cleanupStaleRedemption(params, stripeSessionId);
    throw new Stripe.errors.StripeInvalidRequestError({
      type: "invalid_request_error",
      code: "resource_missing",
      message: `Campaign ${params.campaignKey} is no longer configured`,
    });
  }

  const stripe = getStripe();
  let coupon;
  let price;
  try {
    // Parallel: each is an independent Stripe read; wall time is one RTT.
    [coupon, price] = await Promise.all([
      stripe.coupons.retrieve(campaign.couponId),
      stripe.prices.retrieve(campaign.priceId),
    ]);
  } catch (err) {
    if (
      err instanceof Stripe.errors.StripeInvalidRequestError &&
      err.code === "resource_missing"
    ) {
      log.warn("one_time_purchase stripe resource missing on resume", {
        orgId: params.orgId,
        campaignKey: params.campaignKey,
        couponId: campaign.couponId,
        priceId: campaign.priceId,
        // Stripe's message names the specific resource (coupon vs price).
        stripeMessage: err.message,
      });
      await cleanupStaleRedemption(params, stripeSessionId);
    }
    throw err;
  }

  if (!coupon.valid) {
    log.warn("one_time_purchase coupon no longer valid on resume", {
      orgId: params.orgId,
      campaignKey: params.campaignKey,
      couponId: campaign.couponId,
      redeemBy: coupon.redeem_by,
      maxRedemptions: coupon.max_redemptions,
      timesRedeemed: coupon.times_redeemed,
    });
    await cleanupStaleRedemption(params, stripeSessionId);
    throw new Stripe.errors.StripeInvalidRequestError({
      type: "invalid_request_error",
      code: "resource_missing",
      message: `Coupon ${campaign.couponId} is no longer valid (expired, maxed out, or disabled)`,
    });
  }

  if (!price.active) {
    log.warn("one_time_purchase price no longer active on resume", {
      orgId: params.orgId,
      campaignKey: params.campaignKey,
      priceId: campaign.priceId,
    });
    await cleanupStaleRedemption(params, stripeSessionId);
    throw new Stripe.errors.StripeInvalidRequestError({
      type: "invalid_request_error",
      code: "resource_missing",
      message: `Price ${campaign.priceId} is no longer active`,
    });
  }
}

async function cleanupStaleRedemption(
  params: RedemptionParams,
  stripeSessionId: string,
): Promise<void> {
  const db = globalThis.services.db;
  const stripe = getStripe();
  // Expire the Stripe session so it stops showing up in dashboard listings.
  // If this throws, let it propagate — the original error (coupon gone, price
  // archived, etc.) is lost but so is the need to surface it once we can no
  // longer keep Stripe state in sync. Sessions auto-expire after 24h anyway,
  // so the side effect of a failed expire is cosmetic.
  await stripe.checkout.sessions.expire(stripeSessionId);
  await db
    .delete(orgPromoRedemption)
    .where(
      and(
        eq(orgPromoRedemption.orgId, params.orgId),
        eq(orgPromoRedemption.campaignKey, params.campaignKey),
      ),
    );
}
