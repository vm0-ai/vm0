import { command } from "ccstate";
import type {
  ConcurrencySubscriptionChangePreviewResponse,
  ConcurrencySubscriptionChangeResponse,
} from "@vm0/api-contracts/contracts/zero-billing";
import { orgConcurrencySubscriptions } from "@vm0/db/schema/org-concurrency-subscription";
import { orgPlanEntitlements } from "@vm0/db/schema/org-plan-entitlement";
import { and, eq } from "drizzle-orm";

import {
  getStripeClient,
  type StripeInvoice,
  type StripeInvoiceLine,
  type StripeSubscription,
  type StripeSubscriptionItem,
} from "../external/stripe-client";
import { nowDate } from "../../lib/time";
import { db$, writeDb$, type ReadonlyDb } from "../external/db";
import {
  activeConcurrencySubscriptions,
  isConcurrencyPriceId,
} from "./org-concurrency-entitlements.service";

const CONCURRENCY_SUBSCRIPTION_QUANTITY_MAX = 1000;

interface ConcurrencySubscriptionArgs {
  readonly orgId: string;
  readonly subscriptionId: string;
}

interface ConcurrencySubscriptionChangeArgs extends ConcurrencySubscriptionArgs {
  readonly quantity: number;
}

interface ReduceConcurrencySubscriptionArgs extends ConcurrencySubscriptionChangeArgs {
  readonly successUrl: string;
}

interface StripeConcurrencySubscriptionChangeArgs {
  readonly subscriptionId: string;
  readonly quantity: number;
  readonly mode: "absolute" | "increase" | "reduce";
}

interface AddStripeConcurrencySubscriptionItemArgs {
  readonly subscriptionId: string;
  readonly priceId: string;
  readonly quantity: number;
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

type PreviewConcurrencySubscriptionChangeResult =
  | {
      readonly ok: true;
      readonly preview: ConcurrencySubscriptionChangePreviewResponse;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "not_found"
        | "canceling"
        | "no_change"
        | "pending_update";
    };

type ChangeConcurrencySubscriptionResult =
  | {
      readonly ok: true;
      readonly response: ConcurrencySubscriptionChangeResponse;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "not_found"
        | "canceling"
        | "invalid_quantity"
        | "pending_update";
    };

type StripeConcurrencySubscriptionChangeResult =
  | {
      readonly ok: true;
      readonly response: ConcurrencySubscriptionChangeResponse;
    }
  | {
      readonly ok: false;
      readonly reason: "invalid_quantity" | "pending_update";
    };

type ReduceConcurrencySubscriptionResult =
  | { readonly ok: true; readonly url: string }
  | {
      readonly ok: false;
      readonly reason:
        | "not_found"
        | "canceling"
        | "not_reduction"
        | "pending_update";
    };

async function findActiveConcurrencySubscription(
  db: ReadonlyDb,
  args: ConcurrencySubscriptionArgs,
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

async function isPlanSubscription(
  db: ReadonlyDb,
  args: ConcurrencySubscriptionArgs,
): Promise<boolean> {
  const [plan] = await db
    .select({ orgId: orgPlanEntitlements.orgId })
    .from(orgPlanEntitlements)
    .where(
      and(
        eq(orgPlanEntitlements.orgId, args.orgId),
        eq(orgPlanEntitlements.stripeSubscriptionId, args.subscriptionId),
      ),
    )
    .limit(1);
  return plan !== undefined;
}

function concurrencySubscriptionItem(
  items: readonly StripeSubscriptionItem[],
): { readonly id: string; readonly quantity: number } | null {
  const item = concurrencyPriceItem(items);
  if (!item || !item.quantity) {
    return null;
  }
  return { id: item.id, quantity: item.quantity };
}

function concurrencyPriceItem(
  items: readonly StripeSubscriptionItem[],
): StripeSubscriptionItem | undefined {
  return items.find((candidate) => {
    return isConcurrencyPriceId(candidate.price.id);
  });
}

function expandedLatestInvoice(
  subscription: StripeSubscription,
): StripeInvoice | null {
  return subscription.latest_invoice &&
    typeof subscription.latest_invoice !== "string"
    ? subscription.latest_invoice
    : null;
}

function appliedConcurrencyChangeResponse(
  subscription: StripeSubscription,
): ConcurrencySubscriptionChangeResponse {
  if (!subscription.pending_update) {
    return { status: "processing", hostedInvoiceUrl: null };
  }
  const invoice = expandedLatestInvoice(subscription);
  if (!invoice?.hosted_invoice_url) {
    throw new Error(
      "Pending concurrency subscription update has no hosted invoice URL",
    );
  }
  return {
    status: "pending_payment",
    hostedInvoiceUrl: invoice.hosted_invoice_url,
  };
}

export const addStripeConcurrencySubscriptionItem$ = command(
  async (
    _,
    args: AddStripeConcurrencySubscriptionItemArgs,
    signal: AbortSignal,
  ): Promise<StripeConcurrencySubscriptionChangeResult> => {
    if (
      !Number.isSafeInteger(args.quantity) ||
      args.quantity < 1 ||
      args.quantity > CONCURRENCY_SUBSCRIPTION_QUANTITY_MAX
    ) {
      return { ok: false, reason: "invalid_quantity" };
    }

    const stripe = getStripeClient();
    const subscription = await stripe.subscriptions.retrieve(
      args.subscriptionId,
      { expand: ["latest_invoice"] },
    );
    signal.throwIfAborted();

    if (subscription.pending_update) {
      const pendingItem = concurrencyPriceItem(
        subscription.pending_update.subscription_items ?? [],
      );
      return pendingItem?.quantity === args.quantity
        ? {
            ok: true,
            response: appliedConcurrencyChangeResponse(subscription),
          }
        : { ok: false, reason: "pending_update" };
    }

    const currentItem = concurrencyPriceItem(subscription.items.data);
    if (currentItem?.quantity === args.quantity) {
      return {
        ok: true,
        response: { status: "completed", hostedInvoiceUrl: null },
      };
    }

    const updatedSubscription = await stripe.subscriptions.update(
      subscription.id,
      {
        items: [
          currentItem
            ? { id: currentItem.id, quantity: args.quantity }
            : { price: args.priceId, quantity: args.quantity },
        ],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: Math.floor(nowDate().getTime() / 1000),
        expand: ["latest_invoice"],
      },
    );
    signal.throwIfAborted();
    return {
      ok: true,
      response: appliedConcurrencyChangeResponse(updatedSubscription),
    };
  },
);

function invoiceAmount(invoice: StripeInvoice, description: string): number {
  if (
    !Number.isSafeInteger(invoice.amount_due) ||
    invoice.amount_due < 0 ||
    invoice.currency.length !== 3
  ) {
    throw new Error(`Stripe ${description} has an invalid amount`);
  }
  return invoice.amount_due;
}

function invoiceLinePriceId(line: StripeInvoiceLine): string | null {
  const price = line.pricing?.price_details?.price;
  return typeof price === "string"
    ? price
    : (price?.id ?? line.price?.id ?? null);
}

function invoiceLineAmountWithTax(line: StripeInvoiceLine): number {
  const exclusiveTax = (line.taxes ?? []).reduce((total, tax) => {
    return tax.tax_behavior === "exclusive" ? total + tax.amount : total;
  }, 0);
  const amount = line.amount + exclusiveTax;
  if (!Number.isSafeInteger(amount)) {
    throw new Error("Stripe concurrency preview line has an invalid amount");
  }
  return amount;
}

function immediateProrationAmount(
  invoice: StripeInvoice,
  prorationTimestamp: number,
): number {
  const lines = invoice.lines.data.filter((line) => {
    const priceId = invoiceLinePriceId(line);
    return (
      line.parent?.subscription_item_details?.proration === true &&
      line.period.start === prorationTimestamp &&
      priceId !== null &&
      isConcurrencyPriceId(priceId)
    );
  });
  const amount = lines.reduce((total, line) => {
    return total + invoiceLineAmountWithTax(line);
  }, 0);
  if (lines.length === 0 || !Number.isSafeInteger(amount)) {
    throw new Error("Stripe concurrency preview has an invalid amount");
  }
  return Math.max(0, amount);
}

const previewStripeConcurrencySubscriptionChange$ = command(
  async (
    _,
    args: ConcurrencySubscriptionChangeArgs,
    signal: AbortSignal,
  ): Promise<PreviewConcurrencySubscriptionChangeResult> => {
    const stripe = getStripeClient();
    const subscription = await stripe.subscriptions.retrieve(
      args.subscriptionId,
    );
    signal.throwIfAborted();
    const item = concurrencySubscriptionItem(subscription.items.data);
    if (!item) {
      throw new Error(
        "Concurrency subscription has no active concurrency item",
      );
    }
    if (subscription.pending_update) {
      return { ok: false, reason: "pending_update" };
    }
    if (args.quantity === item.quantity) {
      return { ok: false, reason: "no_change" };
    }

    const prorationTimestamp = Math.floor(nowDate().getTime() / 1000);
    const items = [{ id: item.id, quantity: args.quantity }];
    const [immediatePreview, recurringPreview] = await Promise.all([
      stripe.invoices.createPreview({
        subscription: subscription.id,
        preview_mode: "next",
        subscription_details: {
          items,
          proration_behavior: "always_invoice",
          proration_date: prorationTimestamp,
        },
      }),
      stripe.invoices.createPreview({
        subscription: subscription.id,
        preview_mode: "recurring",
        subscription_details: { items },
      }),
    ]);
    signal.throwIfAborted();
    if (immediatePreview.currency !== recurringPreview.currency) {
      throw new Error(
        "Stripe concurrency previews returned different currencies",
      );
    }

    return {
      ok: true,
      preview: {
        currentQuantity: item.quantity,
        targetQuantity: args.quantity,
        immediateAmountCents: immediateProrationAmount(
          immediatePreview,
          prorationTimestamp,
        ),
        nextRecurringAmountCents: invoiceAmount(
          recurringPreview,
          "concurrency recurring preview",
        ),
        currency: recurringPreview.currency,
      },
    };
  },
);

export const applyStripeConcurrencySubscriptionChange$ = command(
  async (
    _,
    args: StripeConcurrencySubscriptionChangeArgs,
    signal: AbortSignal,
  ): Promise<StripeConcurrencySubscriptionChangeResult> => {
    const stripe = getStripeClient();
    const subscription = await stripe.subscriptions.retrieve(
      args.subscriptionId,
      { expand: ["latest_invoice"] },
    );
    signal.throwIfAborted();
    const item = concurrencySubscriptionItem(subscription.items.data);
    if (!item) {
      throw new Error(
        "Concurrency subscription has no active concurrency item",
      );
    }
    const targetQuantity =
      args.mode === "increase" ? item.quantity + args.quantity : args.quantity;
    if (
      !Number.isSafeInteger(targetQuantity) ||
      targetQuantity < 1 ||
      targetQuantity > CONCURRENCY_SUBSCRIPTION_QUANTITY_MAX
    ) {
      return { ok: false, reason: "invalid_quantity" };
    }
    if (args.mode === "reduce" && targetQuantity > item.quantity) {
      return { ok: false, reason: "invalid_quantity" };
    }

    if (subscription.pending_update) {
      const pendingItem = concurrencySubscriptionItem(
        subscription.pending_update.subscription_items ?? [],
      );
      return pendingItem?.quantity === targetQuantity
        ? {
            ok: true,
            response: appliedConcurrencyChangeResponse(subscription),
          }
        : { ok: false, reason: "pending_update" };
    }
    if (targetQuantity === item.quantity) {
      return {
        ok: true,
        response: { status: "completed", hostedInvoiceUrl: null },
      };
    }

    const updatedSubscription = await stripe.subscriptions.update(
      subscription.id,
      {
        items: [{ id: item.id, quantity: targetQuantity }],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: Math.floor(nowDate().getTime() / 1000),
        expand: ["latest_invoice"],
      },
    );
    signal.throwIfAborted();
    return {
      ok: true,
      response: appliedConcurrencyChangeResponse(updatedSubscription),
    };
  },
);

export const previewConcurrencySubscriptionChange$ = command(
  async (
    { get, set },
    args: ConcurrencySubscriptionChangeArgs,
    signal: AbortSignal,
  ): Promise<PreviewConcurrencySubscriptionChangeResult> => {
    const subscription = await findActiveConcurrencySubscription(
      get(db$),
      args,
    );
    signal.throwIfAborted();
    if (!subscription) {
      return { ok: false, reason: "not_found" };
    }
    if (subscription.cancelAtPeriodEnd) {
      return { ok: false, reason: "canceling" };
    }
    return await set(previewStripeConcurrencySubscriptionChange$, args, signal);
  },
);

export const changeConcurrencySubscription$ = command(
  async (
    { get, set },
    args: ConcurrencySubscriptionChangeArgs,
    signal: AbortSignal,
  ): Promise<ChangeConcurrencySubscriptionResult> => {
    const subscription = await findActiveConcurrencySubscription(
      get(db$),
      args,
    );
    signal.throwIfAborted();
    if (!subscription) {
      return { ok: false, reason: "not_found" };
    }
    if (subscription.cancelAtPeriodEnd) {
      return { ok: false, reason: "canceling" };
    }
    return await set(
      applyStripeConcurrencySubscriptionChange$,
      {
        subscriptionId: args.subscriptionId,
        quantity: args.quantity,
        mode: "absolute",
      },
      signal,
    );
  },
);

export const cancelConcurrencySubscription$ = command(
  async (
    { get, set },
    args: ConcurrencySubscriptionArgs,
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
    if (await isPlanSubscription(get(db$), args)) {
      const stripeSubscription = await stripe.subscriptions.retrieve(
        args.subscriptionId,
      );
      signal.throwIfAborted();
      const item = concurrencyPriceItem(stripeSubscription.items.data);
      if (!item) {
        throw new Error("Plan subscription has no concurrency item");
      }
      await stripe.subscriptions.update(args.subscriptionId, {
        items: [{ id: item.id, quantity: 0 }],
        proration_behavior: "none",
      });
    } else {
      await stripe.subscriptions.update(args.subscriptionId, {
        cancel_at_period_end: true,
      });
    }
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

// Old web/app clients can call this legacy reduction endpoint for the ~2-day
// client version-skew window. Remove the route, contract, and client fallback
// with #26152 after #26116 has been deployed beyond that window.
export const reduceConcurrencySubscription$ = command(
  async (
    { get, set },
    args: ReduceConcurrencySubscriptionArgs,
    signal: AbortSignal,
  ): Promise<ReduceConcurrencySubscriptionResult> => {
    const subscription = await findActiveConcurrencySubscription(
      get(db$),
      args,
    );
    signal.throwIfAborted();
    if (!subscription) {
      return { ok: false, reason: "not_found" };
    }
    if (subscription.cancelAtPeriodEnd) {
      return { ok: false, reason: "canceling" };
    }
    if (args.quantity >= subscription.quantity) {
      return { ok: false, reason: "not_reduction" };
    }

    const result = await set(
      applyStripeConcurrencySubscriptionChange$,
      {
        subscriptionId: args.subscriptionId,
        quantity: args.quantity,
        mode: "reduce",
      },
      signal,
    );
    if (!result.ok) {
      return {
        ok: false,
        reason:
          result.reason === "pending_update"
            ? "pending_update"
            : "not_reduction",
      };
    }
    return {
      ok: true,
      url:
        result.response.status === "pending_payment"
          ? result.response.hostedInvoiceUrl
          : args.successUrl,
    };
  },
);

export const restoreConcurrencySubscription$ = command(
  async (
    { get, set },
    args: ConcurrencySubscriptionArgs,
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
    if (await isPlanSubscription(get(db$), args)) {
      const stripeSubscription = await stripe.subscriptions.retrieve(
        args.subscriptionId,
      );
      signal.throwIfAborted();
      const item = concurrencyPriceItem(stripeSubscription.items.data);
      if (!item) {
        throw new Error("Plan subscription has no concurrency item");
      }
      await stripe.subscriptions.update(args.subscriptionId, {
        items: [{ id: item.id, quantity: subscription.quantity }],
        proration_behavior: "none",
      });
    } else {
      await stripe.subscriptions.update(args.subscriptionId, {
        cancel_at_period_end: false,
      });
    }
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
