import { command } from "ccstate";
import type { Stripe } from "stripe";
import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import { getStripeClient } from "../external/stripe-client";
import { activePriceId } from "./zero-billing-checkout.service";

const L = logger("BillingDowngrade");

const TIER_RANK = Object.freeze<Record<OrgTier, number>>({
  free: 0,
  "pro-suspend": 0,
  pro: 1,
  team: 2,
});

type DowngradeResult =
  | { readonly ok: true; readonly effectiveDate: string | null }
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
}

interface DowngradeOrg {
  readonly tier: string;
  readonly stripeSubscriptionId: string;
  readonly currentPeriodEnd: Date | null;
  readonly pendingSubscriptionScheduleId: string | null;
}

interface DowngradeContext {
  readonly db: Db;
  readonly stripe: ReturnType<typeof getStripeClient>;
  readonly orgId: string;
  readonly org: DowngradeOrg;
  readonly signal: AbortSignal;
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

function subscriptionCurrentItem(
  subscription: Stripe.Subscription,
): Stripe.SubscriptionItem {
  const currentItem = subscription.items.data[0];
  if (!currentItem) {
    throw new Error("Subscription has no items");
  }
  return currentItem;
}

function subscriptionScheduleId(
  subscription: Stripe.Subscription,
): string | null {
  const schedule = subscription.schedule;
  if (typeof schedule === "string") {
    return schedule;
  }
  return schedule?.id ?? null;
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

async function scheduleCancellationAtPeriodEnd(
  context: DowngradeContext,
): Promise<string> {
  const subscription = await context.stripe.subscriptions.retrieve(
    context.org.stripeSubscriptionId,
  );
  context.signal.throwIfAborted();

  const scheduleId =
    context.org.pendingSubscriptionScheduleId ??
    subscriptionScheduleId(subscription);
  const currentItem = subscriptionCurrentItem(subscription);
  const currentPhaseRange = subscriptionItemPhaseRange(currentItem);
  const effectiveDate =
    context.org.currentPeriodEnd ?? new Date(currentPhaseRange.endDate * 1000);

  if (scheduleId) {
    await context.stripe.subscriptionSchedules.update(scheduleId, {
      end_behavior: "cancel",
      proration_behavior: "none",
      phases: [
        {
          start_date: currentPhaseRange.startDate,
          end_date: currentPhaseRange.endDate,
          items: [
            schedulePhaseItem(currentItem.price.id, currentItem.quantity),
          ],
          proration_behavior: "none",
        },
      ],
    });
  } else {
    await context.stripe.subscriptions.update(
      context.org.stripeSubscriptionId,
      {
        cancel_at_period_end: true,
      },
    );
  }
  context.signal.throwIfAborted();

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
  context.signal.throwIfAborted();

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
): Promise<string> {
  const subscription = await context.stripe.subscriptions.retrieve(
    context.org.stripeSubscriptionId,
  );
  context.signal.throwIfAborted();

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
  context.signal.throwIfAborted();

  const scheduleId = existingScheduleId ?? createdSchedule?.id;
  if (!scheduleId) {
    throw new Error("Subscription schedule ID is missing");
  }

  const { startDate, endDate } = createdSchedule
    ? subscriptionPhaseRange(createdSchedule, currentItem)
    : subscriptionItemPhaseRange(currentItem);
  const currentPriceId = currentItem.price.id;
  const quantity = currentItem.quantity;

  await context.stripe.subscriptionSchedules.update(scheduleId, {
    end_behavior: "release",
    proration_behavior: "none",
    phases: [
      {
        start_date: startDate,
        end_date: endDate,
        items: [schedulePhaseItem(currentPriceId, quantity)],
        proration_behavior: "none",
      },
      {
        start_date: endDate,
        duration: phaseDuration(currentItem.price),
        items: [schedulePhaseItem(proPriceId, quantity)],
        proration_behavior: "none",
      },
    ],
  });
  context.signal.throwIfAborted();

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
  context.signal.throwIfAborted();

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
 * - `* → pro-suspend`: schedules cancel-at-period-end and flips local
 *   `cancelAtPeriodEnd` flag. effectiveDate = currentPeriodEnd ISO string.
 * - `team → pro`: schedules a period-end phase change to Pro. effectiveDate
 *   is the current phase end ISO string.
 */
export const downgradeSubscription$ = command(
  async (
    { set },
    args: DowngradeArgs,
    signal: AbortSignal,
  ): Promise<DowngradeResult> => {
    const writeDb = set(writeDb$);

    const [org] = await writeDb
      .select({
        tier: orgMetadata.tier,
        stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
        currentPeriodEnd: orgMetadata.currentPeriodEnd,
        pendingSubscriptionScheduleId:
          orgMetadata.pendingSubscriptionScheduleId,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();

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
      stripeSubscriptionId: org.stripeSubscriptionId,
      currentPeriodEnd: org.currentPeriodEnd,
      pendingSubscriptionScheduleId: org.pendingSubscriptionScheduleId,
    };
    const context = {
      db: writeDb,
      stripe,
      orgId: args.orgId,
      org: downgradeOrg,
      signal,
    };
    const effectiveDate =
      args.targetTier === "pro-suspend"
        ? await scheduleCancellationAtPeriodEnd(context)
        : await scheduleDowngradeToPro(context, currentTier);

    return { ok: true, effectiveDate };
  },
);
