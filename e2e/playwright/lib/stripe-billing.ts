import { randomUUID } from "node:crypto";

import Stripe from "stripe";

type LegacyPlanTier = "pro" | "team";

export interface LegacyPlanSubscription {
  readonly customerId: string;
  readonly id: string;
  readonly status: string;
  readonly tier: LegacyPlanTier;
}

export interface AtomGrantInvoice {
  readonly expiresAt: Date;
  readonly id: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for billing transition E2E tests`);
  }
  return value;
}

function stripeClient(): Stripe {
  return new Stripe(requiredEnvironment("STRIPE_SECRET_KEY"));
}

function subscriptionCustomerId(subscription: Stripe.Subscription): string {
  return typeof subscription.customer === "string"
    ? subscription.customer
    : subscription.customer.id;
}

function isActiveSubscription(subscription: Stripe.Subscription): boolean {
  return subscription.status === "active" || subscription.status === "trialing";
}

export async function findOrgLegacyPlanSubscription(args: {
  readonly orgId: string;
  readonly tier: LegacyPlanTier;
}): Promise<LegacyPlanSubscription> {
  const subscriptions = await stripeClient().subscriptions.list({
    limit: 100,
    status: "all",
  });
  const matches = subscriptions.data.filter((subscription) => {
    return (
      subscription.metadata.orgId === args.orgId &&
      subscription.metadata.tier === args.tier &&
      isActiveSubscription(subscription)
    );
  });
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one active ${args.tier} legacy Plan subscription for the E2E organization; found ${matches.length}`,
    );
  }
  const subscription = matches[0];
  if (!subscription) {
    throw new Error("Legacy Plan subscription lookup returned no match");
  }
  return {
    customerId: subscriptionCustomerId(subscription),
    id: subscription.id,
    status: subscription.status,
    tier: args.tier,
  };
}

export async function readStripeSubscriptionStatus(
  subscriptionId: string,
): Promise<string> {
  return (await stripeClient().subscriptions.retrieve(subscriptionId)).status;
}

export async function createMarkedAtomTeamGrant(args: {
  readonly orgId: string;
  readonly subscription: LegacyPlanSubscription;
  readonly lifetimeMs?: number;
}): Promise<AtomGrantInvoice> {
  const stripe = stripeClient();
  const atomGrantPrice = requiredEnvironment("ATOM_GRANT_PRICE");
  const startsAt = Math.floor(Date.now() / 1000);
  const expiresAt = new Date(Date.now() + (args.lifetimeMs ?? 60_000));
  const expiresAtUnix = Math.floor(expiresAt.getTime() / 1000);
  const idempotencyScope = `playwright-atom-${args.orgId}-${randomUUID()}`;
  const metadata = {
    type: "atom_grant",
    purpose: "atom_grant",
    source: "atom_entitlement",
    orgId: args.orgId,
    tier: "team",
    duration: "e2e",
    atomGrantExpiresAt: expiresAt.toISOString(),
    planOverrideMode: "preserve_purchased_pro_v1",
  };

  const invoice = await stripe.invoices.create(
    {
      auto_advance: false,
      collection_method: "charge_automatically",
      customer: args.subscription.customerId,
      metadata,
    },
    { idempotencyKey: `${idempotencyScope}-invoice` },
  );
  await stripe.invoiceItems.create(
    {
      customer: args.subscription.customerId,
      invoice: invoice.id,
      metadata,
      period: { start: startsAt, end: expiresAtUnix },
      pricing: { price: atomGrantPrice },
      quantity: 1,
    },
    { idempotencyKey: `${idempotencyScope}-line` },
  );
  const finalized = await stripe.invoices.finalizeInvoice(
    invoice.id,
    {},
    { idempotencyKey: `${idempotencyScope}-finalize` },
  );
  const paid =
    finalized.status === "paid"
      ? finalized
      : await stripe.invoices.pay(
          invoice.id,
          {},
          { idempotencyKey: `${idempotencyScope}-pay` },
        );
  if (paid.status !== "paid") {
    throw new Error("Atom grant invoice did not reach paid status");
  }
  return { expiresAt, id: paid.id };
}

export async function reconcileBillingEntitlements(
  apiUrl: string,
): Promise<void> {
  const response = await fetch(
    new URL("/api/cron/reconcile-billing-entitlements", apiUrl),
    {
      headers: {
        Authorization: `Bearer ${requiredEnvironment("CRON_SECRET")}`,
        ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
          ? {
              "x-vercel-protection-bypass":
                process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
            }
          : {}),
      },
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Billing entitlement reconciliation failed with HTTP ${response.status}`,
    );
  }
  await response.body?.cancel();
}
