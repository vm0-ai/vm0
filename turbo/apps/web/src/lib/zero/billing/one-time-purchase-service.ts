import { and, eq } from "drizzle-orm";
import { orgPromoRedemption } from "../../../db/schema/org-promo-redemption";
import { creditExpiresRecord } from "../../../db/schema/credit-expires-record";
import { createOneTimeCheckoutSession } from "./billing-service";
import { getStripe } from "../stripe";
import { logger } from "../../shared/logger";

const log = logger("one-time-purchase");

/**
 * The outcome of a `/buy/[productId]` attempt.
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
  productId: string;
  promoCode: string;
  successUrl: string;
  cancelUrl: string;
}

/**
 * Claim-or-resume the Stripe Checkout session for (org, product, promoCode).
 *
 * Only one session per triple can exist thanks to the unique index on
 * `org_promo_redemption`. If we can claim the row we create a fresh Stripe
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
      productId: params.productId,
      promoCode: params.promoCode,
      stripeSessionId: session.sessionId,
    })
    .onConflictDoNothing()
    .returning({ stripeSessionId: orgPromoRedemption.stripeSessionId });

  if (inserted.length > 0) {
    return { kind: "redirect", url: session.url };
  }

  // Lost the race — some other caller claimed the row. Resume against the
  // winner's session.
  const winner = await selectRedemption(params);
  if (!winner) {
    throw new Error("Race lost but redemption row missing");
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
        eq(orgPromoRedemption.productId, params.productId),
        eq(orgPromoRedemption.promoCode, params.promoCode),
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
        eq(orgPromoRedemption.productId, params.productId),
        eq(orgPromoRedemption.promoCode, params.promoCode),
      ),
    );
  log.info("one_time_purchase session refreshed", {
    orgId: params.orgId,
    productId: params.productId,
    oldSessionId: stripeSessionId,
    newSessionId: fresh.sessionId,
  });
  return { kind: "redirect", url: fresh.url };
}
