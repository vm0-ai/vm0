import type StripeSDK from "stripe";
import { command } from "ccstate";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq, sql } from "drizzle-orm";

import { writeDb$ } from "../external/db";
import { getStripeClient } from "../external/stripe-client";
import { nowDate } from "../external/time";
import { settle } from "../utils";
import { logger } from "../../lib/log";
import { stripePreviewMetadata } from "./stripe-preview-metadata.service";

const L = logger("CreditRecharge");

const CREDITS_PER_DOLLAR = 1000;
const STALE_THRESHOLD_MINUTES = 10;

interface ClaimedRechargeState {
  readonly credits: number;
  readonly tier: string;
  readonly stripeCustomerId: string;
  readonly stripeSubscriptionId: string | null;
  readonly autoRechargeEnabled: boolean;
  readonly autoRechargeThreshold: number;
  readonly autoRechargeAmount: number;
  readonly autoRechargePendingAt: Date | null;
}

function resolvePaymentMethodId(
  pm: string | StripeSDK.PaymentMethod | null | undefined,
): string | null {
  if (typeof pm === "string") {
    return pm;
  }
  return pm?.id ?? null;
}

async function resolvePaymentMethod(
  stripe: StripeSDK,
  org: ClaimedRechargeState,
): Promise<string | null> {
  const customer = await stripe.customers.retrieve(org.stripeCustomerId);
  if ("deleted" in customer && customer.deleted) {
    L.warn("Stripe customer is deleted, skipping auto-recharge", {
      stripeCustomerId: org.stripeCustomerId,
    });
    return null;
  }
  const customerPm = resolvePaymentMethodId(
    (customer as StripeSDK.Customer).invoice_settings?.default_payment_method,
  );
  if (customerPm) {
    return customerPm;
  }

  if (org.stripeSubscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(
      org.stripeSubscriptionId,
    );
    const subPm = resolvePaymentMethodId(subscription.default_payment_method);
    if (subPm) {
      return subPm;
    }
  }

  L.warn("No payment method found on customer or subscription", {
    stripeCustomerId: org.stripeCustomerId,
  });
  return null;
}

/**
 * Trigger a Stripe auto-recharge invoice if the org's balance has
 * crossed the recharge threshold. Mirrors web's `triggerAutoRecharge`.
 *
 * Atomically claims the recharge slot via UPDATE … RETURNING with a
 * WHERE clause that filters on:
 *  - autoRechargeEnabled = true
 *  - tier is paid (pro/team)
 *  - stripeCustomerId / threshold / amount NOT NULL
 *  - credits <= threshold
 *  - pendingAt IS NULL OR pendingAt < now() - 10 minutes
 *
 * Verbatim same WHERE shape as web so api and web don't double-claim
 * during rollout. The 10-minute stale-threshold lets a hung Stripe call
 * release the slot eventually.
 *
 * On Stripe error: clearPendingFlag so retry can fire on the next
 * legitimate processOrgUsageEvents call.
 *
 * Note: credits are GRANTED via the Stripe webhook
 * `handleAutoRechargeInvoicePaid` (separate route surface, out of
 * scope here). This Command only triggers the invoice; never grant
 * credits here.
 */
export const triggerAutoRecharge$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    const writeDb = set(writeDb$);

    const clearPendingFlag = async (): Promise<void> => {
      await writeDb
        .update(orgMetadata)
        .set({ autoRechargePendingAt: null, updatedAt: nowDate() })
        .where(eq(orgMetadata.orgId, orgId));
    };

    const claimed = await writeDb
      .update(orgMetadata)
      .set({ autoRechargePendingAt: nowDate(), updatedAt: nowDate() })
      .where(
        sql`${orgMetadata.orgId} = ${orgId}
            AND ${orgMetadata.autoRechargeEnabled} = true
            AND ${orgMetadata.tier} IN ('pro', 'team')
            AND ${orgMetadata.stripeCustomerId} IS NOT NULL
            AND ${orgMetadata.autoRechargeThreshold} IS NOT NULL
            AND ${orgMetadata.autoRechargeAmount} IS NOT NULL
            AND ${orgMetadata.credits} <= ${orgMetadata.autoRechargeThreshold}
            AND (${orgMetadata.autoRechargePendingAt} IS NULL
                 OR ${orgMetadata.autoRechargePendingAt} < now() - interval '${sql.raw(String(STALE_THRESHOLD_MINUTES))} minutes')`,
      )
      .returning({
        credits: orgMetadata.credits,
        tier: orgMetadata.tier,
        stripeCustomerId: orgMetadata.stripeCustomerId,
        stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
        autoRechargeEnabled: orgMetadata.autoRechargeEnabled,
        autoRechargeThreshold: orgMetadata.autoRechargeThreshold,
        autoRechargeAmount: orgMetadata.autoRechargeAmount,
        autoRechargePendingAt: orgMetadata.autoRechargePendingAt,
      });
    signal.throwIfAborted();

    const org = claimed[0] as ClaimedRechargeState | undefined;
    if (!org) {
      L.debug("Auto-recharge already pending or conditions unmet", { orgId });
      return;
    }

    const creditsAmount = org.autoRechargeAmount;
    const amountCents = Math.ceil(creditsAmount / CREDITS_PER_DOLLAR) * 100;

    const stripe = getStripeClient();

    const outcome = await settle(
      (async (): Promise<void> => {
        const paymentMethodId = await resolvePaymentMethod(stripe, org);
        signal.throwIfAborted();
        if (!paymentMethodId) {
          await clearPendingFlag();
          return;
        }

        const invoice = await stripe.invoices.create({
          customer: org.stripeCustomerId,
          auto_advance: false,
          default_payment_method: paymentMethodId,
          metadata: {
            type: "auto_recharge",
            orgId,
            creditsAmount: String(creditsAmount),
            ...stripePreviewMetadata(),
          },
        });
        signal.throwIfAborted();

        await stripe.invoiceItems.create({
          invoice: invoice.id,
          customer: org.stripeCustomerId,
          amount: amountCents,
          currency: "usd",
          description: `Credit top-up: ${creditsAmount.toLocaleString()} credits`,
        });
        signal.throwIfAborted();

        await stripe.invoices.finalizeInvoice(invoice.id);
        signal.throwIfAborted();
        await stripe.invoices.pay(invoice.id);
        signal.throwIfAborted();

        L.debug("Auto-recharge invoice created and paid", {
          orgId,
          creditsAmount,
          amountCents,
          invoiceId: invoice.id,
        });
      })(),
    );

    signal.throwIfAborted();

    if (!outcome.ok) {
      const { error } = outcome;
      L.warn("Auto-recharge Stripe call failed, clearing pending flag", {
        orgId,
        error: error instanceof Error ? error.message : String(error),
      });
      await clearPendingFlag();
    }
  },
);
