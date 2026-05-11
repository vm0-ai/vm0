import { command } from "ccstate";
import { sql, eq } from "drizzle-orm";
import { orgMetadata } from "@vm0/db/schema/org-metadata";

import { env } from "../../lib/env";
import { writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import { getStripeClient } from "../external/stripe-client";

interface CreateCheckoutSessionArgs {
  readonly orgId: string;
  readonly priceId: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

/** Returns the active (first) price ID for a given tier. */
export function activePriceId(tier: "pro" | "team"): string | undefined {
  return env("ZERO_PRICE")?.[tier]?.[0];
}

/**
 * Get or create a Stripe customer for an org. Serializes per-org via
 * advisory transaction lock so concurrent checkout requests cannot
 * mint multiple Stripe customers and orphan webhook events. Lock key
 * `stripe_customer_${orgId}` matches apps/web exactly so cross-process
 * races during the web→api cutover coordinate on the same lock.
 */
const getOrCreateStripeCustomer$ = command(
  ({ set }, orgId: string, signal: AbortSignal): Promise<string> => {
    const writeDb = set(writeDb$);
    return writeDb.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('stripe_customer_' || ${orgId}))`,
      );
      signal.throwIfAborted();

      const [row] = await tx
        .select({ stripeCustomerId: orgMetadata.stripeCustomerId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, orgId))
        .limit(1);
      signal.throwIfAborted();

      if (row?.stripeCustomerId) {
        return row.stripeCustomerId;
      }

      const stripe = getStripeClient();
      const customer = await stripe.customers.create({ metadata: { orgId } });
      signal.throwIfAborted();

      await tx
        .insert(orgMetadata)
        .values({ orgId, stripeCustomerId: customer.id, credits: 0 })
        .onConflictDoUpdate({
          target: orgMetadata.orgId,
          set: { stripeCustomerId: customer.id, updatedAt: nowDate() },
        });
      signal.throwIfAborted();

      return customer.id;
    });
  },
);

/**
 * Create a Stripe Checkout session for subscription. Returns the
 * checkout session URL. Mirrors apps/web's createCheckoutSession
 * (allow_promotion_codes + subscription metadata orgId tag).
 */
export const createCheckoutSession$ = command(
  async (
    { set },
    args: CreateCheckoutSessionArgs,
    signal: AbortSignal,
  ): Promise<string> => {
    const customerId = await set(
      getOrCreateStripeCustomer$,
      args.orgId,
      signal,
    );
    signal.throwIfAborted();

    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: args.priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      subscription_data: { metadata: { orgId: args.orgId } },
    });
    signal.throwIfAborted();

    if (!session.url) {
      throw new Error("Stripe checkout session did not return a URL");
    }
    return session.url;
  },
);
