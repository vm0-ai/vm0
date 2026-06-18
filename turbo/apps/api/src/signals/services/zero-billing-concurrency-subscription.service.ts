import { command } from "ccstate";
import { orgConcurrencySubscriptions } from "@vm0/db/schema/org-concurrency-subscription";
import { and, eq } from "drizzle-orm";

import { getStripeClient } from "../external/stripe-client";
import { nowDate } from "../external/time";
import { db$, writeDb$, type ReadonlyDb } from "../external/db";
import { activeConcurrencySubscriptions } from "./org-concurrency-entitlements.service";

interface CancelConcurrencySubscriptionArgs {
  readonly orgId: string;
  readonly subscriptionId: string;
}

type CancelConcurrencySubscriptionResult =
  | {
      readonly ok: true;
      readonly currentPeriodEnd: string | null;
    }
  | {
      readonly ok: false;
      readonly reason: "not_found";
    };

async function findActiveConcurrencySubscription(
  db: ReadonlyDb,
  args: CancelConcurrencySubscriptionArgs,
): Promise<
  Awaited<ReturnType<typeof activeConcurrencySubscriptions>>[number] | null
> {
  const subscriptions = await activeConcurrencySubscriptions(
    db,
    args.orgId,
    nowDate(),
  );
  return (
    subscriptions.find((candidate) => {
      return candidate.id === args.subscriptionId;
    }) ?? null
  );
}

export const cancelConcurrencySubscription$ = command(
  async (
    { get, set },
    args: CancelConcurrencySubscriptionArgs,
    signal: AbortSignal,
  ): Promise<CancelConcurrencySubscriptionResult> => {
    const subscription = await findActiveConcurrencySubscription(
      get(db$),
      args,
    );
    signal.throwIfAborted();
    if (!subscription) {
      return { ok: false, reason: "not_found" };
    }
    const stripe = getStripeClient();
    await stripe.subscriptions.update(args.subscriptionId, {
      cancel_at_period_end: true,
    });
    signal.throwIfAborted();

    await set(writeDb$)
      .update(orgConcurrencySubscriptions)
      .set({ cancelAtPeriodEnd: true, updatedAt: nowDate() })
      .where(
        and(
          eq(orgConcurrencySubscriptions.orgId, args.orgId),
          eq(
            orgConcurrencySubscriptions.stripeSubscriptionId,
            args.subscriptionId,
          ),
        ),
      );
    signal.throwIfAborted();

    return {
      ok: true,
      currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
    };
  },
);

export const restoreConcurrencySubscription$ = command(
  async (
    { get, set },
    args: CancelConcurrencySubscriptionArgs,
    signal: AbortSignal,
  ): Promise<CancelConcurrencySubscriptionResult> => {
    const subscription = await findActiveConcurrencySubscription(
      get(db$),
      args,
    );
    signal.throwIfAborted();
    if (!subscription) {
      return { ok: false, reason: "not_found" };
    }

    const stripe = getStripeClient();
    await stripe.subscriptions.update(args.subscriptionId, {
      cancel_at_period_end: false,
    });
    signal.throwIfAborted();

    await set(writeDb$)
      .update(orgConcurrencySubscriptions)
      .set({ cancelAtPeriodEnd: false, updatedAt: nowDate() })
      .where(
        and(
          eq(orgConcurrencySubscriptions.orgId, args.orgId),
          eq(
            orgConcurrencySubscriptions.stripeSubscriptionId,
            args.subscriptionId,
          ),
        ),
      );
    signal.throwIfAborted();

    return {
      ok: true,
      currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
    };
  },
);
