import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import StripeSDK from "stripe";
import { orgPromoRedemption } from "@vm0/db/schema/org-promo-redemption";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";

import { logger } from "../../lib/log";
import { db$, writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import { getStripeClient } from "../external/stripe-client";
import { safeAsync } from "../utils";
import { getOrCreateStripeCustomer$ } from "./billing-customer.service";
import { getCampaign } from "./one-time-products";

const log = logger("zero-billing-redeem");

/**
 * Result of attempting to start or resume a one-time campaign redemption.
 *
 * - `redirect`         — send the user to `url`.
 * - `already_granted`  — credits already landed in the org ledger.
 * - `processing`       — Stripe accepted the payment but the webhook hasn't
 *                        persisted the grant yet; the user should refresh.
 * - `stripe_error`     — Stripe rejected the create/retrieve/coupon/price
 *                        call; the route maps this to `campaign_misconfigured`.
 */
type RedemptionResult =
  | { readonly kind: "redirect"; readonly url: string }
  | { readonly kind: "already_granted" }
  | { readonly kind: "processing" }
  | {
      readonly kind: "stripe_error";
      readonly type: string;
      readonly code: string | null;
      readonly message: string;
    };

interface RedemptionArgs {
  readonly orgId: string;
  readonly campaignKey: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

export const startOrResumeRedemption$ = command(
  async (
    { set },
    args: RedemptionArgs,
    signal: AbortSignal,
  ): Promise<RedemptionResult> => {
    const outcome = await safeAsync(async () => {
      return await runRedemption(args, set, signal);
    });
    signal.throwIfAborted();
    if ("ok" in outcome) {
      return outcome.ok;
    }
    if (outcome.error instanceof StripeSDK.errors.StripeError) {
      log.error("redeem: stripe error", {
        orgId: args.orgId,
        campaignKey: args.campaignKey,
        type: outcome.error.type,
        code: outcome.error.code,
        message: outcome.error.message,
      });
      return {
        kind: "stripe_error",
        type: outcome.error.type,
        code: outcome.error.code ?? null,
        message: outcome.error.message,
      };
    }
    throw outcome.error;
  },
);

async function runRedemption(
  args: RedemptionArgs,
  set: Parameters<Parameters<typeof command>[0]>[0]["set"],
  signal: AbortSignal,
): Promise<RedemptionResult> {
  // Fast path: row already exists — go straight to resume logic without
  // paying for a throwaway Stripe session.
  const existing = await set(selectRedemption$, args, signal);
  if (existing) {
    return await set(
      resumeExisting$,
      { args, stripeSessionId: existing.stripeSessionId },
      signal,
    );
  }

  // Claim the row by creating a Stripe session and inserting in one go.
  const session = await set(createOneTimeCheckoutSession$, args, signal);
  signal.throwIfAborted();

  const writeDb = set(writeDb$);
  const inserted = await writeDb
    .insert(orgPromoRedemption)
    .values({
      orgId: args.orgId,
      campaignKey: args.campaignKey,
      stripeSessionId: session.sessionId,
    })
    .onConflictDoNothing()
    .returning({ stripeSessionId: orgPromoRedemption.stripeSessionId });
  signal.throwIfAborted();

  if (inserted.length > 0) {
    return { kind: "redirect", url: session.url };
  }

  // Lost the race — expire our throwaway and resume against the winner.
  const stripe = getStripeClient();
  await stripe.checkout.sessions.expire(session.sessionId);
  signal.throwIfAborted();

  const winner = await set(selectRedemption$, args, signal);
  if (!winner) {
    log.error("one_time_purchase race inconsistency", {
      orgId: args.orgId,
      campaignKey: args.campaignKey,
    });
    throw new Error(
      "Redemption state is temporarily inconsistent; please retry in a moment",
    );
  }
  return await set(
    resumeExisting$,
    { args, stripeSessionId: winner.stripeSessionId },
    signal,
  );
}

const selectRedemption$ = command(
  async (
    { get },
    args: Pick<RedemptionArgs, "orgId" | "campaignKey">,
    signal: AbortSignal,
  ): Promise<{ stripeSessionId: string } | undefined> => {
    const readDb = get(db$);
    const [row] = await readDb
      .select({ stripeSessionId: orgPromoRedemption.stripeSessionId })
      .from(orgPromoRedemption)
      .where(
        and(
          eq(orgPromoRedemption.orgId, args.orgId),
          eq(orgPromoRedemption.campaignKey, args.campaignKey),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return row;
  },
);

const resumeExisting$ = command(
  async (
    { get, set },
    input: { args: RedemptionArgs; stripeSessionId: string },
    signal: AbortSignal,
  ): Promise<RedemptionResult> => {
    const { args, stripeSessionId } = input;

    // Source of truth for "credits granted" is the ledger, not the Stripe session.
    const readDb = get(db$);
    const [granted] = await readDb
      .select({ id: creditExpiresRecord.id })
      .from(creditExpiresRecord)
      .where(
        and(
          eq(creditExpiresRecord.orgId, args.orgId),
          eq(creditExpiresRecord.stripeInvoiceId, stripeSessionId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (granted) {
      return { kind: "already_granted" };
    }

    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.retrieve(stripeSessionId);
    signal.throwIfAborted();

    if (session.status === "open" && session.url) {
      await set(
        ensureCampaignStillAvailable$,
        { args, stripeSessionId },
        signal,
      );
      return { kind: "redirect", url: session.url };
    }
    if (session.status === "complete") {
      return { kind: "processing" };
    }

    // status is "expired" (or unrecognised) — rotate the row to a fresh session
    // so the user can try again.
    const fresh = await set(createOneTimeCheckoutSession$, args, signal);
    const writeDb = set(writeDb$);
    await writeDb
      .update(orgPromoRedemption)
      .set({ stripeSessionId: fresh.sessionId, updatedAt: nowDate() })
      .where(
        and(
          eq(orgPromoRedemption.orgId, args.orgId),
          eq(orgPromoRedemption.campaignKey, args.campaignKey),
        ),
      );
    signal.throwIfAborted();
    log.debug("one_time_purchase session refreshed", {
      orgId: args.orgId,
      campaignKey: args.campaignKey,
      oldSessionId: stripeSessionId,
      newSessionId: fresh.sessionId,
    });
    return { kind: "redirect", url: fresh.url };
  },
);

const ensureCampaignStillAvailable$ = command(
  async (
    { set },
    input: { args: RedemptionArgs; stripeSessionId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const { args, stripeSessionId } = input;
    const campaign = getCampaign(args.campaignKey);
    if (!campaign) {
      // Route already gated unknown campaigns; if we got here, env drifted
      // mid-request. Surfacing as misconfigured is fine.
      await set(cleanupStaleRedemption$, { args, stripeSessionId }, signal);
      throw new StripeSDK.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        code: "resource_missing",
        message: `Campaign ${args.campaignKey} is no longer configured`,
      });
    }

    const stripe = getStripeClient();
    // Parallel: each is an independent Stripe read; wall time is one RTT.
    const fetched = await safeAsync(async () => {
      return await Promise.all([
        stripe.coupons.retrieve(campaign.couponId),
        stripe.prices.retrieve(campaign.priceId),
      ]);
    });
    signal.throwIfAborted();
    if ("error" in fetched) {
      if (
        fetched.error instanceof StripeSDK.errors.StripeInvalidRequestError &&
        fetched.error.code === "resource_missing"
      ) {
        log.warn("one_time_purchase stripe resource missing on resume", {
          orgId: args.orgId,
          campaignKey: args.campaignKey,
          couponId: campaign.couponId,
          priceId: campaign.priceId,
          stripeMessage: fetched.error.message,
        });
        await set(cleanupStaleRedemption$, { args, stripeSessionId }, signal);
      }
      throw fetched.error;
    }
    signal.throwIfAborted();
    const [coupon, price] = fetched.ok;

    if (!coupon.valid) {
      log.warn("one_time_purchase coupon no longer valid on resume", {
        orgId: args.orgId,
        campaignKey: args.campaignKey,
        couponId: campaign.couponId,
      });
      await set(cleanupStaleRedemption$, { args, stripeSessionId }, signal);
      throw new StripeSDK.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        code: "resource_missing",
        message: `Coupon ${campaign.couponId} is no longer valid`,
      });
    }

    if (!price.active) {
      log.warn("one_time_purchase price no longer active on resume", {
        orgId: args.orgId,
        campaignKey: args.campaignKey,
        priceId: campaign.priceId,
      });
      await set(cleanupStaleRedemption$, { args, stripeSessionId }, signal);
      throw new StripeSDK.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        code: "resource_missing",
        message: `Price ${campaign.priceId} is no longer active`,
      });
    }
  },
);

const cleanupStaleRedemption$ = command(
  async (
    { set },
    input: { args: RedemptionArgs; stripeSessionId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const { args, stripeSessionId } = input;
    const stripe = getStripeClient();
    // Best-effort: don't let session-already-expired prevent row cleanup.
    // Sessions auto-expire after 24h anyway; a failure here is cosmetic.
    const expireOutcome = await safeAsync(async () => {
      return await stripe.checkout.sessions.expire(stripeSessionId);
    });
    signal.throwIfAborted();
    if ("error" in expireOutcome) {
      log.debug("one_time_purchase session already expired or un-expirable", {
        orgId: args.orgId,
        campaignKey: args.campaignKey,
        stripeSessionId,
      });
    }
    signal.throwIfAborted();
    const writeDb = set(writeDb$);
    await writeDb
      .delete(orgPromoRedemption)
      .where(
        and(
          eq(orgPromoRedemption.orgId, args.orgId),
          eq(orgPromoRedemption.campaignKey, args.campaignKey),
        ),
      );
    signal.throwIfAborted();
  },
);

const createOneTimeCheckoutSession$ = command(
  async (
    { set },
    args: RedemptionArgs,
    signal: AbortSignal,
  ): Promise<{ sessionId: string; url: string }> => {
    const campaign = getCampaign(args.campaignKey);
    if (!campaign) {
      throw new Error(`Unknown campaign: ${args.campaignKey}`);
    }

    const customerId = await set(
      getOrCreateStripeCustomer$,
      args.orgId,
      signal,
    );
    signal.throwIfAborted();

    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: customerId,
      line_items: [{ price: campaign.priceId, quantity: 1 }],
      discounts: [{ coupon: campaign.couponId }],
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      metadata: {
        orgId: args.orgId,
        campaignKey: args.campaignKey,
        purpose: "one_time_purchase",
      },
    });
    signal.throwIfAborted();

    if (!session.url) {
      throw new Error("Stripe checkout session did not return a URL");
    }
    return { sessionId: session.id, url: session.url };
  },
);
