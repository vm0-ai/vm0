import { command } from "ccstate";
import type { Stripe } from "stripe";
import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import { getStripeClient } from "../external/stripe-client";
import {
  subscriptionScheduleFinalEnd,
  subscriptionScheduleId,
} from "./stripe-subscription-schedules.service";
import { activePriceId } from "./zero-billing-checkout.service";
import {
  BILLING_DOWNGRADE_PURPOSE,
  billingDefaultPaymentMethodStatus,
  createBillingSetupCheckout,
} from "./zero-billing-payment-method.service";

const L = logger("BillingDowngrade");

const TIER_RANK = Object.freeze<Record<OrgTier, number>>({
  free: 0,
  "pro-suspend": 0,
  pro: 1,
  team: 2,
});

type DowngradeResult =
  | {
      readonly ok: true;
      readonly status: "scheduled";
      readonly effectiveDate: string | null;
    }
  | {
      readonly ok: true;
      readonly status: "payment_method_required";
      readonly checkoutUrl: string;
    }
  | { readonly ok: false; readonly reason: "no_subscription" }
  | {
      readonly ok: false;
      readonly reason: "invalid_target_tier";
      readonly currentTier: OrgTier;
      readonly targetTier: "pro-suspend" | "pro";
    };

interface DowngradeArgs {
  readonly orgId: string;
  readonly targetTier: "pro-suspend" | "pro";
  readonly returnUrl: string;
}

interface DowngradeSubscriptionForOrgArgs {
  readonly orgId: string;
  readonly targetTier: "pro-suspend" | "pro";
  readonly returnUrl?: string;
  readonly requirePaymentMethod?: boolean;
}

interface DowngradeOrg {
  readonly tier: string;
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string;
  readonly currentPeriodEnd: Date | null;
  readonly pendingSubscriptionScheduleId: string | null;
  readonly pendingSubscriptionTargetTier: string | null;
}

interface DowngradeContext {
  readonly db: Db;
  readonly stripe: ReturnType<typeof getStripeClient>;
  readonly orgId: string;
  readonly org: DowngradeOrg;
  readonly signal?: AbortSignal;
}

function subscriptionPhaseRange(
  schedule: Stripe.SubscriptionSchedule,
  subscriptionItem: Stripe.SubscriptionItem,
): { readonly startDate: number; readonly endDate: number } {
  const startDate =
    schedule.current_phase?.start_date ?? subscriptionItem.current_period_start;
  const endDate =
    schedule.current_phase?.end_date ?? subscriptionItem.current_period_end;

  if (endDate <= startDate) {
    throw new Error("Subscription period end must be after period start");
  }

  return { startDate, endDate };
}

function phaseDuration(
  price: Stripe.Price,
): Stripe.SubscriptionScheduleUpdateParams.Phase.Duration {
  const recurring = price.recurring;
  if (!recurring) {
    throw new Error("Subscription price is not recurring");
  }

  return {
    interval: recurring.interval,
    interval_count: recurring.interval_count,
  };
}

function schedulePhaseItem(
  priceId: string,
  quantity: number | undefined,
): Stripe.SubscriptionScheduleUpdateParams.Phase.Item {
  return {
    price: priceId,
    quantity: quantity ?? 1,
  };
}

function stripeObjectId(
  value: string | { readonly id: string } | null,
): string | null {
  if (typeof value === "string") {
    return value;
  }
  return value?.id ?? null;
}

function subscriptionSchedulePhaseDiscounts(
  subscription: Stripe.Subscription,
): Stripe.SubscriptionScheduleUpdateParams.Phase.Discount[] {
  const discounts =
    (
      subscription as {
        readonly discounts?: readonly (string | Stripe.Discount)[];
      }
    ).discounts ?? [];
  return discounts.flatMap((discount) => {
    const discountId = stripeObjectId(discount);
    return discountId ? [{ discount: discountId }] : [];
  });
}

function phaseWithDiscounts(
  phase: Stripe.SubscriptionScheduleUpdateParams.Phase,
  discounts: Stripe.SubscriptionScheduleUpdateParams.Phase.Discount[],
): Stripe.SubscriptionScheduleUpdateParams.Phase {
  if (discounts.length === 0) {
    return phase;
  }

  return {
    ...phase,
    discounts,
  };
}

function subscriptionCurrentItem(
  subscription: Stripe.Subscription,
): Stripe.SubscriptionItem {
  const currentItem = subscription.items.data[0];
  if (!currentItem) {
    throw new Error("Subscription has no items");
  }
  return currentItem;
}

function subscriptionItemPhaseRange(
  subscriptionItem: Stripe.SubscriptionItem,
): { readonly startDate: number; readonly endDate: number } {
  const startDate = subscriptionItem.current_period_start;
  const endDate = subscriptionItem.current_period_end;

  if (endDate <= startDate) {
    throw new Error("Subscription period end must be after period start");
  }

  return { startDate, endDate };
}

function subscriptionCancelAt(subscription: Stripe.Subscription): Date | null {
  return typeof subscription.cancel_at === "number"
    ? new Date(subscription.cancel_at * 1000)
    : null;
}

function dateUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function shouldReplacePendingDowngradeSchedule(
  context: DowngradeContext,
  scheduleId: string,
): boolean {
  return (
    context.org.tier === "team" &&
    context.org.pendingSubscriptionScheduleId === scheduleId &&
    context.org.pendingSubscriptionTargetTier === "pro"
  );
}

async function scheduleCancellationAtPeriodEnd(
  context: DowngradeContext,
): Promise<string> {
  const subscription = await context.stripe.subscriptions.retrieve(
    context.org.stripeSubscriptionId,
  );
  context.signal?.throwIfAborted();

  const scheduleId =
    context.org.pendingSubscriptionScheduleId ??
    subscriptionScheduleId(subscription);
  const currentItem = subscriptionCurrentItem(subscription);
  const currentPhaseRange = subscriptionItemPhaseRange(currentItem);
  let effectiveDate =
    context.org.currentPeriodEnd ?? new Date(currentPhaseRange.endDate * 1000);

  if (scheduleId) {
    if (shouldReplacePendingDowngradeSchedule(context, scheduleId)) {
      const discounts = subscriptionSchedulePhaseDiscounts(subscription);
      await context.stripe.subscriptionSchedules.update(scheduleId, {
        end_behavior: "cancel",
        proration_behavior: "none",
        phases: [
          phaseWithDiscounts(
            {
              start_date: currentPhaseRange.startDate,
              end_date: currentPhaseRange.endDate,
              items: [
                schedulePhaseItem(currentItem.price.id, currentItem.quantity),
              ],
              proration_behavior: "none",
            },
            discounts,
          ),
        ],
      });
    } else {
      const schedule =
        await context.stripe.subscriptionSchedules.retrieve(scheduleId);
      effectiveDate =
        subscriptionScheduleFinalEnd(schedule) ??
        context.org.currentPeriodEnd ??
        new Date(currentPhaseRange.endDate * 1000);
      await context.stripe.subscriptionSchedules.update(scheduleId, {
        end_behavior: "cancel",
        proration_behavior: "none",
      });
    }
  } else {
    const cancelAt = subscriptionCancelAt(subscription);
    if (cancelAt) {
      effectiveDate = cancelAt;
    } else if (
      context.org.currentPeriodEnd &&
      dateUnixSeconds(context.org.currentPeriodEnd) > currentPhaseRange.endDate
    ) {
      effectiveDate = context.org.currentPeriodEnd;
      await context.stripe.subscriptions.update(
        context.org.stripeSubscriptionId,
        {
          cancel_at: dateUnixSeconds(effectiveDate),
        },
      );
    } else {
      await context.stripe.subscriptions.update(
        context.org.stripeSubscriptionId,
        {
          cancel_at_period_end: true,
        },
      );
    }
  }
  context.signal?.throwIfAborted();

  await context.db
    .update(orgMetadata)
    .set({
      cancelAtPeriodEnd: true,
      pendingSubscriptionScheduleId: scheduleId,
      pendingSubscriptionTargetTier: "pro-suspend",
      pendingSubscriptionChangeAt: effectiveDate,
      currentPeriodEnd: effectiveDate,
      updatedAt: nowDate(),
    })
    .where(eq(orgMetadata.orgId, context.orgId));
  context.signal?.throwIfAborted();

  const effectiveDateIso = effectiveDate.toISOString();
  L.debug("subscription cancellation initiated", {
    orgId: context.orgId,
    targetTier: "pro-suspend",
    effectiveDate: effectiveDateIso,
  });
  return effectiveDateIso;
}

async function scheduleDowngradeToPro(
  context: DowngradeContext,
  currentTier: OrgTier,
  subscription: Stripe.Subscription,
): Promise<string> {
  const currentItem = subscriptionCurrentItem(subscription);
  const proPriceId = activePriceId("pro");
  if (!proPriceId) {
    throw new Error("Pro plan price ID not configured");
  }

  const existingScheduleId =
    context.org.pendingSubscriptionScheduleId ??
    subscriptionScheduleId(subscription);
  const createdSchedule = existingScheduleId
    ? null
    : await context.stripe.subscriptionSchedules.create({
        from_subscription: context.org.stripeSubscriptionId,
      });
  context.signal?.throwIfAborted();

  const scheduleId = existingScheduleId ?? createdSchedule?.id;
  if (!scheduleId) {
    throw new Error("Subscription schedule ID is missing");
  }

  const { startDate, endDate } = createdSchedule
    ? subscriptionPhaseRange(createdSchedule, currentItem)
    : subscriptionItemPhaseRange(currentItem);
  const currentPriceId = currentItem.price.id;
  const quantity = currentItem.quantity;
  const discounts = subscriptionSchedulePhaseDiscounts(subscription);

  await context.stripe.subscriptionSchedules.update(scheduleId, {
    end_behavior: "release",
    proration_behavior: "none",
    phases: [
      phaseWithDiscounts(
        {
          start_date: startDate,
          end_date: endDate,
          items: [schedulePhaseItem(currentPriceId, quantity)],
          proration_behavior: "none",
        },
        discounts,
      ),
      phaseWithDiscounts(
        {
          start_date: endDate,
          duration: phaseDuration(currentItem.price),
          items: [schedulePhaseItem(proPriceId, quantity)],
          proration_behavior: "none",
        },
        discounts,
      ),
    ],
  });
  context.signal?.throwIfAborted();

  const effectiveDate = new Date(endDate * 1000);
  await context.db
    .update(orgMetadata)
    .set({
      cancelAtPeriodEnd: false,
      pendingSubscriptionScheduleId: scheduleId,
      pendingSubscriptionTargetTier: "pro",
      pendingSubscriptionChangeAt: effectiveDate,
      currentPeriodEnd: effectiveDate,
      updatedAt: nowDate(),
    })
    .where(eq(orgMetadata.orgId, context.orgId));
  context.signal?.throwIfAborted();

  const effectiveDateIso = effectiveDate.toISOString();
  L.debug("subscription downgrade scheduled", {
    orgId: context.orgId,
    from: currentTier,
    to: "pro",
    effectiveDate: effectiveDateIso,
  });
  return effectiveDateIso;
}

/**
 * Downgrade an org's Stripe subscription. Two branches:
 * - `* → pro-suspend`: schedules cancellation and flips the local
 *   `cancelAtPeriodEnd` flag. Existing `cancel_at`, fixed-term paid-through
 *   dates, and external schedule final ends are preserved.
 * - `team → pro`: schedules a period-end phase change to Pro. effectiveDate
 *   is the current phase end ISO string.
 */
export async function downgradeSubscriptionForOrg(
  db: Db,
  args: DowngradeSubscriptionForOrgArgs,
  signal?: AbortSignal,
): Promise<DowngradeResult> {
  const [org] = await db
    .select({
      tier: orgMetadata.tier,
      stripeCustomerId: orgMetadata.stripeCustomerId,
      stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      currentPeriodEnd: orgMetadata.currentPeriodEnd,
      pendingSubscriptionScheduleId: orgMetadata.pendingSubscriptionScheduleId,
      pendingSubscriptionTargetTier: orgMetadata.pendingSubscriptionTargetTier,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, args.orgId))
    .limit(1);
  signal?.throwIfAborted();

  if (!org?.stripeSubscriptionId) {
    return { ok: false, reason: "no_subscription" };
  }

  const currentTier = org.tier as OrgTier;
  if (TIER_RANK[args.targetTier] >= TIER_RANK[currentTier]) {
    return {
      ok: false,
      reason: "invalid_target_tier",
      currentTier,
      targetTier: args.targetTier,
    };
  }

  const stripe = getStripeClient();
  const downgradeOrg: DowngradeOrg = {
    tier: org.tier,
    stripeCustomerId: org.stripeCustomerId,
    stripeSubscriptionId: org.stripeSubscriptionId,
    currentPeriodEnd: org.currentPeriodEnd,
    pendingSubscriptionScheduleId: org.pendingSubscriptionScheduleId,
    pendingSubscriptionTargetTier: org.pendingSubscriptionTargetTier,
  };
  const context = {
    db,
    stripe,
    orgId: args.orgId,
    org: downgradeOrg,
    signal,
  };

  if (args.targetTier === "pro-suspend") {
    const effectiveDate = await scheduleCancellationAtPeriodEnd(context);
    return { ok: true, status: "scheduled", effectiveDate };
  }

  const subscription = await stripe.subscriptions.retrieve(
    org.stripeSubscriptionId,
  );
  signal?.throwIfAborted();

  if (args.requirePaymentMethod !== false) {
    const paymentMethod = await billingDefaultPaymentMethodStatus({
      stripe,
      org: downgradeOrg,
      subscription,
    });
    if (!paymentMethod.ready) {
      if (!paymentMethod.customerId) {
        throw new Error("Stripe subscription has no customer for downgrade");
      }
      if (!args.returnUrl) {
        throw new Error("returnUrl is required to collect a payment method");
      }

      const checkoutUrl = await createBillingSetupCheckout({
        stripe,
        purpose: BILLING_DOWNGRADE_PURPOSE,
        orgId: args.orgId,
        customerId: paymentMethod.customerId,
        subscriptionId: org.stripeSubscriptionId,
        returnUrl: args.returnUrl,
        metadata: { targetTier: args.targetTier },
      });
      return { ok: true, status: "payment_method_required", checkoutUrl };
    }
  }

  const effectiveDate = await scheduleDowngradeToPro(
    context,
    currentTier,
    subscription,
  );
  return { ok: true, status: "scheduled", effectiveDate };
}

export const downgradeSubscription$ = command(
  async (
    { set },
    args: DowngradeArgs,
    signal: AbortSignal,
  ): Promise<DowngradeResult> => {
    const writeDb = set(writeDb$);
    return await downgradeSubscriptionForOrg(writeDb, args, signal);
  },
);
