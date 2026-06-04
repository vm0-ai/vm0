import { command } from "ccstate";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { logger } from "../../lib/log";
import { writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import { getStripeClient } from "../external/stripe-client";

const L = logger("BillingRestore");

type RestoreResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "no_subscription" }
  | { readonly ok: false; readonly reason: "not_scheduled" };

interface RestoreArgs {
  readonly orgId: string;
}

export const restoreSubscription$ = command(
  async (
    { set },
    args: RestoreArgs,
    signal: AbortSignal,
  ): Promise<RestoreResult> => {
    const writeDb = set(writeDb$);

    const [org] = await writeDb
      .select({
        stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
        cancelAtPeriodEnd: orgMetadata.cancelAtPeriodEnd,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();

    if (!org?.stripeSubscriptionId) {
      return { ok: false, reason: "no_subscription" };
    }

    if (!org.cancelAtPeriodEnd) {
      return { ok: false, reason: "not_scheduled" };
    }

    const stripe = getStripeClient();
    await stripe.subscriptions.update(org.stripeSubscriptionId, {
      cancel_at_period_end: false,
    });
    signal.throwIfAborted();

    await writeDb
      .update(orgMetadata)
      .set({ cancelAtPeriodEnd: false, updatedAt: nowDate() })
      .where(eq(orgMetadata.orgId, args.orgId));
    signal.throwIfAborted();

    L.debug("subscription cancellation restored", {
      orgId: args.orgId,
      stripeSubscriptionId: org.stripeSubscriptionId,
    });

    return { ok: true };
  },
);
