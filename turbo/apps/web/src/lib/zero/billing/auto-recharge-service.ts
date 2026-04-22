import { eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { orgMetadata } from "../../../db/schema/org-metadata";
import { grantOrgCredits } from "../org/org-service";
import { createExpiresRecord } from "../credit/credit-expires-service";
import { getStripe } from "../stripe";
import { logger } from "../../shared/logger";

const log = logger("billing:auto-recharge");

/** $1 = 1,000 credits */
const CREDITS_PER_DOLLAR = 1000;

/** Pending recharge older than this is considered stale and can be retried. */
const STALE_THRESHOLD_MINUTES = 10;

/**
 * Sentinel "never expires" timestamp for auto-recharge credits. Writing a
 * real (far-future) value lets us reuse the `(org_id, stripe_invoice_id)`
 * unique index on `credit_expires_record` as the idempotency guard for
 * auto-recharge invoices, while keeping the promised PAYG semantics: the
 * row is never selected by `expireCredits` (which only touches records
 * with `expires_at <= NOW()`).
 */
const AUTO_RECHARGE_NEVER_EXPIRES_AT = new Date("2999-12-31T00:00:00Z");

interface OrgRechargeState {
  credits: number;
  tier: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  autoRechargeEnabled: boolean;
  autoRechargeThreshold: number | null;
  autoRechargeAmount: number | null;
  autoRechargePendingAt: Date | null;
}

function isEligibleForRecharge(
  org: OrgRechargeState,
): org is OrgRechargeState & {
  stripeCustomerId: string;
  autoRechargeThreshold: number;
  autoRechargeAmount: number;
} {
  return (
    org.autoRechargeEnabled &&
    org.tier !== "free" &&
    org.stripeCustomerId !== null &&
    org.autoRechargeThreshold !== null &&
    org.autoRechargeAmount !== null &&
    org.credits <= org.autoRechargeThreshold
  );
}

async function clearPendingFlag(orgId: string): Promise<void> {
  const db = globalThis.services.db;
  await db
    .update(orgMetadata)
    .set({ autoRechargePendingAt: null, updatedAt: new Date() })
    .where(eq(orgMetadata.orgId, orgId));
}

function resolvePaymentMethodId(
  pm: string | Stripe.PaymentMethod | null | undefined,
): string | null {
  if (typeof pm === "string") return pm;
  return pm?.id ?? null;
}

async function resolvePaymentMethod(
  stripe: Stripe,
  org: { stripeCustomerId: string; stripeSubscriptionId: string | null },
  orgId: string,
): Promise<string | null> {
  const customer = await stripe.customers.retrieve(org.stripeCustomerId);
  if (customer.deleted) {
    log.warn("Stripe customer is deleted, skipping auto-recharge", { orgId });
    await clearPendingFlag(orgId);
    return null;
  }

  const customerPm = resolvePaymentMethodId(
    customer.invoice_settings?.default_payment_method,
  );
  if (customerPm) return customerPm;

  if (org.stripeSubscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(
      org.stripeSubscriptionId,
    );
    const subPm = resolvePaymentMethodId(subscription.default_payment_method);
    if (subPm) return subPm;
  }

  log.warn(
    "No payment method found on customer or subscription, skipping auto-recharge",
    { orgId, customerId: org.stripeCustomerId },
  );
  await clearPendingFlag(orgId);
  return null;
}

/**
 * Check if auto-recharge should trigger for an org and, if so,
 * create a Stripe one-time invoice to purchase credits.
 *
 * Called after processOrgCredits commits its transaction.
 * Errors are caught internally — callers should fire-and-forget.
 */
export async function triggerAutoRecharge(orgId: string): Promise<void> {
  const db = globalThis.services.db;

  // Read org state
  const [org] = await db
    .select({
      credits: orgMetadata.credits,
      tier: orgMetadata.tier,
      stripeCustomerId: orgMetadata.stripeCustomerId,
      stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      autoRechargeEnabled: orgMetadata.autoRechargeEnabled,
      autoRechargeThreshold: orgMetadata.autoRechargeThreshold,
      autoRechargeAmount: orgMetadata.autoRechargeAmount,
      autoRechargePendingAt: orgMetadata.autoRechargePendingAt,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  if (!org || !isEligibleForRecharge(org)) return;

  // Atomically claim the recharge slot — only one writer wins.
  // Allows retry if the previous pending is stale (> 10 min).
  const claimed = await db
    .update(orgMetadata)
    .set({ autoRechargePendingAt: new Date(), updatedAt: new Date() })
    .where(
      sql`${orgMetadata.orgId} = ${orgId}
          AND ${orgMetadata.autoRechargeEnabled} = true
          AND (${orgMetadata.autoRechargePendingAt} IS NULL
               OR ${orgMetadata.autoRechargePendingAt} < now() - interval '${sql.raw(String(STALE_THRESHOLD_MINUTES))} minutes')`,
    )
    .returning({ orgId: orgMetadata.orgId });

  if (claimed.length === 0) {
    log.debug("Auto-recharge already pending, skipping", { orgId });
    return;
  }

  const creditsAmount = org.autoRechargeAmount;
  const amountCents = Math.ceil(creditsAmount / CREDITS_PER_DOLLAR) * 100;

  const stripe = getStripe();

  try {
    const paymentMethodId = await resolvePaymentMethod(stripe, org, orgId);
    if (!paymentMethodId) return;

    // Create a one-time invoice with metadata for webhook identification
    const invoice = await stripe.invoices.create({
      customer: org.stripeCustomerId,
      auto_advance: false,
      default_payment_method: paymentMethodId,
      metadata: {
        type: "auto_recharge",
        orgId,
        creditsAmount: String(creditsAmount),
      },
    });

    // Add the line item
    await stripe.invoiceItems.create({
      invoice: invoice.id,
      customer: org.stripeCustomerId,
      amount: amountCents,
      currency: "usd",
      description: `Credit top-up: ${creditsAmount.toLocaleString()} credits`,
    });

    // Finalize and pay immediately
    await stripe.invoices.finalizeInvoice(invoice.id);
    await stripe.invoices.pay(invoice.id);

    log.info("Auto-recharge invoice created and paid", {
      orgId,
      creditsAmount,
      amountCents,
      invoiceId: invoice.id,
    });
  } catch (err) {
    // Payment failed — clear pending flag so next deduction cycle can retry
    log.warn("Auto-recharge Stripe call failed, clearing pending flag", {
      orgId,
      error: err instanceof Error ? err.message : String(err),
    });

    await clearPendingFlag(orgId);
  }
}

/**
 * Handle an auto-recharge invoice.paid webhook event.
 * Grants credits to the org and clears the pending flag.
 *
 * Idempotent: the `(org_id, stripe_invoice_id)` unique index on
 * `credit_expires_record` gates `grantOrgCredits`. A duplicate delivery
 * (Stripe retry, dual-listener, etc.) inserts with ON CONFLICT DO NOTHING,
 * sees `inserted=false`, and bails before re-granting. `expires_at` is set
 * far in the future so `expireCredits` never settles these records — the
 * row exists only as the idempotency marker, the PAYG "never expires"
 * contract is preserved.
 *
 * @returns true if the invoice was an auto-recharge invoice (regardless of
 *   whether credits were freshly granted or the delivery was a duplicate)
 */
export async function handleAutoRechargeInvoicePaid(invoice: {
  id: string;
  metadata: Record<string, string> | null;
}): Promise<boolean> {
  const metadata = invoice.metadata;
  if (!metadata || metadata.type !== "auto_recharge") {
    return false;
  }

  const orgId = metadata.orgId;
  const creditsAmount = Number(metadata.creditsAmount);

  if (!orgId || !creditsAmount || isNaN(creditsAmount)) {
    log.warn("Auto-recharge invoice has invalid metadata", {
      invoiceId: invoice.id,
      metadata,
    });
    return false;
  }

  const db = globalThis.services.db;

  const granted = await db.transaction(async (tx) => {
    const inserted = await createExpiresRecord(tx, orgId, {
      source: "auto_recharge",
      stripeInvoiceId: invoice.id,
      amount: creditsAmount,
      expiresAt: AUTO_RECHARGE_NEVER_EXPIRES_AT,
    });
    if (!inserted) {
      log.info(
        "Auto-recharge invoice already processed — skipping (duplicate delivery)",
        { orgId, invoiceId: invoice.id },
      );
      return false;
    }

    await grantOrgCredits(tx, orgId, creditsAmount);
    await tx
      .update(orgMetadata)
      .set({ autoRechargePendingAt: null, updatedAt: new Date() })
      .where(eq(orgMetadata.orgId, orgId));

    return true;
  });

  if (granted) {
    log.info("Auto-recharge credits granted", {
      orgId,
      creditsAmount,
      invoiceId: invoice.id,
    });
  }

  return true;
}
