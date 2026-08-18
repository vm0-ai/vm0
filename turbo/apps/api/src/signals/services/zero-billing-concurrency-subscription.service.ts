import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import type {
  ConcurrencySubscriptionChangePreviewResponse,
  ConcurrencySubscriptionChangeResponse,
} from "@okouai/api-contracts/contracts/zero-billing";
import { orgConcurrencySubscriptions } from "@okouai/db/schema/org-concurrency-subscription";
import { orgPlanEntitlements } from "@okouai/db/schema/org-plan-entitlement";
import { orgUsageAllowanceEntitlements } from "@okouai/db/schema/org-usage-allowance";
import {
  usagePackAllocationChanges,
  usagePackSubscriptionChanges,
} from "@okouai/db/schema/usage-pack-subscription";
import { and, eq } from "drizzle-orm";

import {
  getStripeClient,
  stripeErrorInfo,
  type StripeClient,
  type StripeInvoice,
  type StripeInvoiceCreatePreviewParams,
  type StripeInvoiceLine,
  type StripePriceRecurring,
  type StripeRef,
  type StripeSchedulePhase,
  type StripeSchedulePhaseDiscountParam,
  type StripeSchedulePhaseItemParam,
  type StripeSchedulePhaseParam,
  type StripeSubscription,
  type StripeSubscriptionItem,
  type StripeSubscriptionSchedule,
  type StripeSubscriptionUpdateItemParam,
} from "../external/stripe-client";
import { nowDate } from "../../lib/time";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { settle } from "../utils";
import {
  activeConcurrencySubscriptions,
  isConcurrencyPriceId,
} from "./org-concurrency-entitlements.service";
import { completeBillingOperationInvoice } from "./billing-operation-invoice.service";
import {
  setStripeSubscriptionPaymentMethod,
  type BillingPurchasePaymentMethod,
} from "./billing-payment-method.service";
import { subscriptionScheduleHasNoFutureChanges } from "./stripe-subscription-schedules.service";

const CONCURRENCY_SUBSCRIPTION_QUANTITY_MAX = 1000;
const STRIPE_INVOICE_LINE_PAGE_SIZE = 100;

interface ConcurrencySubscriptionArgs {
  readonly orgId: string;
  readonly subscriptionId: string;
}

interface ConcurrencySubscriptionChangeArgs extends ConcurrencySubscriptionArgs {
  readonly quantity: number;
}

interface ConfirmedConcurrencySubscriptionChangeArgs extends ConcurrencySubscriptionChangeArgs {
  readonly paymentMethod?: BillingPurchasePaymentMethod;
}

interface ReduceConcurrencySubscriptionArgs extends ConcurrencySubscriptionChangeArgs {
  readonly successUrl: string;
}

interface StripeConcurrencySubscriptionChangeArgs extends ConcurrencySubscriptionArgs {
  readonly quantity: number;
  readonly mode: "absolute" | "increase" | "reduce";
  readonly hasScheduledConcurrencyChange: boolean;
  readonly paymentMethod?: BillingPurchasePaymentMethod;
}

interface AddStripeConcurrencySubscriptionItemArgs extends ConcurrencySubscriptionArgs {
  readonly priceId: string;
  readonly quantity: number;
  readonly paymentMethod?: BillingPurchasePaymentMethod;
}

type CancelConcurrencySubscriptionResult =
  | {
      readonly ok: true;
      readonly currentPeriodEnd: string | null;
    }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "pending_update";
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
        | "invalid_quantity"
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
      readonly subscription: StripeSubscription;
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

async function isSharedBillingSubscription(
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
  if (plan) {
    return true;
  }
  const [allowance] = await db
    .select({ orgId: orgUsageAllowanceEntitlements.orgId })
    .from(orgUsageAllowanceEntitlements)
    .where(
      and(
        eq(orgUsageAllowanceEntitlements.orgId, args.orgId),
        eq(
          orgUsageAllowanceEntitlements.stripeSubscriptionId,
          args.subscriptionId,
        ),
      ),
    )
    .limit(1);
  return allowance !== undefined;
}

async function writeScheduledConcurrencyChange(
  db: Db,
  args: {
    readonly orgId: string;
    readonly subscriptionId: string;
    readonly quantity: number | null;
    readonly effectiveAt: string | null;
  },
): Promise<void> {
  await db
    .update(orgConcurrencySubscriptions)
    .set({
      scheduledSlots: args.quantity,
      scheduledChangeAt: args.effectiveAt ? new Date(args.effectiveAt) : null,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(orgConcurrencySubscriptions.orgId, args.orgId),
        eq(
          orgConcurrencySubscriptions.stripeSubscriptionId,
          args.subscriptionId,
        ),
      ),
    );
}

function concurrencySubscriptionItem(
  items: readonly StripeSubscriptionItem[],
): {
  readonly id: string;
  readonly priceId: string;
  readonly quantity: number;
} | null {
  const item = concurrencyPriceItem(items);
  if (!item || !item.quantity) {
    return null;
  }
  return { id: item.id, priceId: item.price.id, quantity: item.quantity };
}

function concurrencyPriceItem(
  items: readonly StripeSubscriptionItem[],
): StripeSubscriptionItem | undefined {
  return items.find((candidate) => {
    return isConcurrencyPriceId(candidate.price.id);
  });
}

function stripeObjectId(value: StripeRef | undefined): string | null {
  if (typeof value === "string") {
    return value;
  }
  return value?.id ?? null;
}

type ConcurrencyScheduleOwner = "plan" | "usage_pack" | null;

async function concurrencyScheduleOwner(
  db: ReadonlyDb,
  orgId: string,
  scheduleId: string,
): Promise<ConcurrencyScheduleOwner> {
  const [usagePackChange] = await db
    .select({
      subscriptionChangeId: usagePackAllocationChanges.subscriptionChangeId,
      sourceTier: usagePackSubscriptionChanges.sourceTier,
      targetTier: usagePackSubscriptionChanges.targetTier,
    })
    .from(usagePackAllocationChanges)
    .leftJoin(
      usagePackSubscriptionChanges,
      eq(
        usagePackSubscriptionChanges.id,
        usagePackAllocationChanges.subscriptionChangeId,
      ),
    )
    .where(
      and(
        eq(usagePackAllocationChanges.orgId, orgId),
        eq(usagePackAllocationChanges.stripeScheduleId, scheduleId),
        eq(usagePackAllocationChanges.status, "scheduled"),
      ),
    )
    .limit(1);
  if (!usagePackChange) {
    return null;
  }
  return usagePackChange.subscriptionChangeId !== null &&
    usagePackChange.sourceTier !== usagePackChange.targetTier
    ? "plan"
    : "usage_pack";
}

function subscriptionPhaseItems(
  subscription: StripeSubscription,
): StripeSchedulePhaseItemParam[] {
  return subscription.items.data.map((item) => {
    return { price: item.price.id, quantity: item.quantity ?? 1 };
  });
}

function subscriptionPhaseDiscounts(
  subscription: StripeSubscription,
): StripeSchedulePhaseDiscountParam[] {
  return (subscription.discounts ?? []).flatMap((discount) => {
    const id = stripeObjectId(discount);
    return id ? [{ discount: id }] : [];
  });
}

function phaseWithDiscounts(
  phase: StripeSchedulePhaseParam,
  discounts: readonly StripeSchedulePhaseDiscountParam[],
): StripeSchedulePhaseParam {
  return discounts.length === 0
    ? phase
    : { ...phase, discounts: [...discounts] };
}

function schedulePhaseItems(
  phase: StripeSchedulePhase,
): StripeSchedulePhaseItemParam[] {
  if (!phase.items || phase.items.length === 0) {
    throw new Error("Stripe subscription schedule phase has no items");
  }
  return phase.items.map((item) => {
    const price = stripeObjectId(item.price);
    const quantity = item.quantity ?? 1;
    if (!price || !Number.isSafeInteger(quantity) || quantity < 1) {
      throw new Error("Stripe subscription schedule phase has invalid items");
    }
    return { price, quantity };
  });
}

function schedulePhaseDiscounts(
  phase: StripeSchedulePhase,
): StripeSchedulePhaseDiscountParam[] {
  return (phase.discounts ?? []).map((discount) => {
    const id = stripeObjectId(discount.discount);
    if (!id) {
      throw new Error(
        "Stripe subscription schedule phase has an invalid discount",
      );
    }
    return { discount: id };
  });
}

function currentAndFutureSchedulePhases(
  schedule: StripeSubscriptionSchedule,
): readonly StripeSchedulePhase[] {
  const currentPhase = schedule.current_phase;
  if (schedule.end_behavior !== "release" || !currentPhase) {
    throw new Error("Stripe subscription schedule cannot be safely updated");
  }
  const currentPhaseIndex = schedule.phases.findIndex((phase) => {
    return (
      phase.start_date === currentPhase.start_date &&
      phase.end_date === currentPhase.end_date
    );
  });
  if (currentPhaseIndex === -1) {
    throw new Error("Stripe subscription schedule lost its current phase");
  }
  const phases = schedule.phases.slice(currentPhaseIndex);
  if (
    phases.length === 0 ||
    phases.some((phase) => {
      return (phase.add_invoice_items?.length ?? 0) > 0;
    })
  ) {
    throw new Error("Stripe subscription schedule cannot be safely updated");
  }
  return phases;
}

function concurrencyScheduleMergeParams(
  schedule: StripeSubscriptionSchedule,
  priceId: string,
  targetQuantity: number,
  prorationBehavior: "always_invoice" | "none",
): NonNullable<StripeInvoiceCreatePreviewParams["schedule_details"]> {
  return {
    end_behavior: "release",
    proration_behavior: prorationBehavior,
    phases: currentAndFutureSchedulePhases(schedule).map((phase) => {
      const items = [
        ...schedulePhaseItems(phase).filter((item) => {
          return !isConcurrencyPriceId(item.price);
        }),
        { price: priceId, quantity: targetQuantity },
      ];
      return phaseWithDiscounts(
        {
          start_date: phase.start_date,
          end_date: phase.end_date,
          items,
          proration_behavior: "none",
        },
        schedulePhaseDiscounts(phase),
      );
    }),
  };
}

function concurrencyItemPeriod(item: StripeSubscriptionItem): {
  readonly start: number;
  readonly end: number;
} {
  if (item.current_period_end <= item.current_period_start) {
    throw new Error("Concurrency subscription has an invalid billing period");
  }
  return {
    start: item.current_period_start,
    end: item.current_period_end,
  };
}

function concurrencySchedulePeriod(
  item: StripeSubscriptionItem,
  schedule: StripeSubscriptionSchedule | null,
): { readonly start: number; readonly end: number } {
  const currentPhase = schedule?.current_phase;
  if (!currentPhase) {
    return concurrencyItemPeriod(item);
  }
  if (currentPhase.end_date <= currentPhase.start_date) {
    throw new Error("Concurrency schedule has an invalid current phase");
  }
  return {
    start: currentPhase.start_date,
    end: currentPhase.end_date,
  };
}

function concurrencyRecurringDuration(
  item: StripeSubscriptionItem,
): StripePriceRecurring {
  const recurring = item.price.recurring;
  if (!recurring) {
    throw new Error("Concurrency subscription price is not recurring");
  }
  return {
    interval: recurring.interval,
    interval_count: recurring.interval_count,
  };
}

function scheduleFutureItems(
  subscription: StripeSubscription,
  schedule: StripeSubscriptionSchedule | null,
  targetQuantity: number,
): StripeSchedulePhaseItemParam[] {
  const scheduledItems = schedule?.phases[schedule.phases.length - 1]?.items;
  const baseItems =
    scheduledItems && scheduledItems.length > 0
      ? scheduledItems.flatMap((item) => {
          const price = stripeObjectId(item.price);
          return price ? [{ price, quantity: item.quantity ?? 1 }] : [];
        })
      : subscriptionPhaseItems(subscription);
  const currentItem = concurrencyPriceItem(subscription.items.data);
  if (!currentItem) {
    throw new Error("Concurrency subscription has no active concurrency item");
  }
  return [
    ...baseItems.filter((item) => {
      return !isConcurrencyPriceId(item.price);
    }),
    ...(targetQuantity > 0
      ? [{ price: currentItem.price.id, quantity: targetQuantity }]
      : []),
  ];
}

function concurrencyScheduleUpdateParams(
  subscription: StripeSubscription,
  schedule: StripeSubscriptionSchedule | null,
  targetQuantity: number,
  period: { readonly start: number; readonly end: number },
): NonNullable<StripeInvoiceCreatePreviewParams["schedule_details"]> {
  const item = concurrencyPriceItem(subscription.items.data);
  if (!item?.quantity) {
    throw new Error("Concurrency subscription has no active concurrency item");
  }
  const discounts = subscriptionPhaseDiscounts(subscription);
  return {
    end_behavior: "release",
    proration_behavior: "none",
    phases: [
      phaseWithDiscounts(
        {
          start_date: period.start,
          end_date: period.end,
          items: subscriptionPhaseItems(subscription),
          proration_behavior: "none",
        },
        discounts,
      ),
      phaseWithDiscounts(
        {
          start_date: period.end,
          duration: concurrencyRecurringDuration(item),
          items: scheduleFutureItems(subscription, schedule, targetQuantity),
          proration_behavior: "none",
        },
        discounts,
      ),
    ],
  };
}

async function scheduleConcurrencyChange(
  subscription: StripeSubscription,
  targetQuantity: number,
  signal: AbortSignal,
): Promise<Date> {
  const item = concurrencyPriceItem(subscription.items.data);
  if (!item?.quantity) {
    throw new Error("Concurrency subscription has no active concurrency item");
  }
  const stripe = getStripeClient();
  const existingScheduleId = stripeObjectId(subscription.schedule);
  const existingSchedule = existingScheduleId
    ? await stripe.subscriptionSchedules.retrieve(existingScheduleId)
    : null;
  signal.throwIfAborted();
  const createdSchedule = existingScheduleId
    ? null
    : await stripe.subscriptionSchedules.create(
        { from_subscription: subscription.id },
        {
          idempotencyKey: `concurrency-change:${subscription.id}:${randomUUID()}:schedule-create`,
        },
      );
  signal.throwIfAborted();
  const schedule = existingSchedule ?? createdSchedule;
  const scheduleId = existingScheduleId ?? schedule?.id;
  if (!scheduleId) {
    throw new Error("Stripe did not return a subscription schedule ID");
  }
  const schedulePeriod = concurrencySchedulePeriod(item, schedule);
  await stripe.subscriptionSchedules.update(
    scheduleId,
    concurrencyScheduleUpdateParams(
      subscription,
      existingSchedule,
      targetQuantity,
      schedulePeriod,
    ),
    {
      idempotencyKey: `concurrency-change:${subscription.id}:${randomUUID()}:schedule-update`,
    },
  );
  signal.throwIfAborted();
  return new Date(schedulePeriod.end * 1000);
}

function expandedLatestInvoice(
  subscription: StripeSubscription,
): StripeInvoice | null {
  return subscription.latest_invoice &&
    typeof subscription.latest_invoice !== "string"
    ? subscription.latest_invoice
    : null;
}

async function appliedConcurrencyChangeResponse(
  stripe: StripeClient,
  subscription: StripeSubscription,
  targetQuantity: number,
  signal: AbortSignal,
): Promise<ConcurrencySubscriptionChangeResponse> {
  const invoice = expandedLatestInvoice(subscription);
  if (!invoice) {
    return { status: "processing", hostedInvoiceUrl: null };
  }
  const result = await completeBillingOperationInvoice(
    stripe,
    invoice,
    `concurrency:${subscription.id}:${targetQuantity}`,
    signal,
  );
  if (result.status === "pending_payment") {
    return result;
  }
  return { status: "processing", hostedInvoiceUrl: null };
}

function latestInvoiceId(subscription: StripeSubscription): string | null {
  const invoice = subscription.latest_invoice;
  return typeof invoice === "string" ? invoice : (invoice?.id ?? null);
}

function isConcurrencyPaymentActionRequired(error: unknown): boolean {
  const code = stripeErrorInfo(error)?.code;
  return (
    code === "authentication_required" ||
    code === "invoice_payment_intent_requires_action" ||
    code === "payment_intent_action_required"
  );
}

async function appliedScheduledConcurrencyChangeResponse(
  stripe: StripeClient,
  subscription: StripeSubscription,
  previousInvoiceId: string | null,
  settleInvoice: boolean,
  signal: AbortSignal,
): Promise<ConcurrencySubscriptionChangeResponse> {
  let invoice = expandedLatestInvoice(subscription);
  if (
    !invoice ||
    invoice.id === previousInvoiceId ||
    invoice.paid === true ||
    invoice.status === "paid"
  ) {
    return { status: "processing", hostedInvoiceUrl: null };
  }
  if (!settleInvoice) {
    return { status: "processing", hostedInvoiceUrl: null };
  }

  const idempotencyKeyPrefix = `concurrency-change:${subscription.id}:${invoice.id}`;
  if (invoice.status === "draft") {
    invoice = await stripe.invoices.finalizeInvoice(
      invoice.id,
      {},
      { idempotencyKey: `${idempotencyKeyPrefix}:finalize` },
    );
    signal.throwIfAborted();
  }
  if (invoice.status === "open") {
    const paid = await settle(
      stripe.invoices.pay(
        invoice.id,
        {},
        { idempotencyKey: `${idempotencyKeyPrefix}:pay` },
      ),
      signal,
    );
    if (paid.ok) {
      invoice = paid.value;
    } else {
      if (!isConcurrencyPaymentActionRequired(paid.error)) {
        throw paid.error;
      }
      invoice = await stripe.invoices.retrieve(invoice.id);
      signal.throwIfAborted();
    }
  }
  if (invoice.paid === true || invoice.status === "paid") {
    return { status: "completed", hostedInvoiceUrl: null };
  }
  if (!invoice.hosted_invoice_url) {
    throw new Error("Stripe concurrency invoice could not be paid");
  }
  return {
    status: "pending_payment",
    hostedInvoiceUrl: invoice.hosted_invoice_url,
  };
}

async function applyConcurrencyToUsagePackSchedule(
  stripe: StripeClient,
  args: {
    readonly subscription: StripeSubscription;
    readonly scheduleId: string;
    readonly schedule: StripeSubscriptionSchedule;
    readonly priceId: string;
    readonly targetQuantity: number;
    readonly prorationBehavior: "always_invoice" | "none";
  },
  signal: AbortSignal,
): Promise<{
  readonly response: ConcurrencySubscriptionChangeResponse;
  readonly subscription: StripeSubscription;
}> {
  const previousInvoiceId = latestInvoiceId(args.subscription);
  await stripe.subscriptionSchedules.update(
    args.scheduleId,
    concurrencyScheduleMergeParams(
      args.schedule,
      args.priceId,
      args.targetQuantity,
      args.prorationBehavior,
    ),
    {
      idempotencyKey: `concurrency-change:${args.subscription.id}:${randomUUID()}:schedule-update`,
    },
  );
  signal.throwIfAborted();
  const updatedSubscription = await stripe.subscriptions.retrieve(
    args.subscription.id,
    { expand: ["latest_invoice"] },
  );
  signal.throwIfAborted();
  return {
    response: await appliedScheduledConcurrencyChangeResponse(
      stripe,
      updatedSubscription,
      previousInvoiceId,
      args.prorationBehavior === "always_invoice",
      signal,
    ),
    subscription: updatedSubscription,
  };
}

export const addStripeConcurrencySubscriptionItem$ = command(
  async (
    { get },
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
            response: await appliedConcurrencyChangeResponse(
              stripe,
              subscription,
              args.quantity,
              signal,
            ),
            subscription,
          }
        : { ok: false, reason: "pending_update" };
    }

    const currentItem = concurrencyPriceItem(subscription.items.data);
    if (currentItem?.quantity === args.quantity) {
      return {
        ok: true,
        response: { status: "completed", hostedInvoiceUrl: null },
        subscription,
      };
    }
    const schedulePreparation = await prepareConcurrencySchedule(
      get(db$),
      stripe,
      {
        orgId: args.orgId,
        subscription,
        hasScheduledConcurrencyChange: false,
      },
      signal,
    );
    if (!schedulePreparation.ok) {
      return { ok: false, reason: "pending_update" };
    }
    if (schedulePreparation.kind === "usage_pack") {
      const applied = await applyConcurrencyToUsagePackSchedule(
        stripe,
        {
          subscription,
          scheduleId: schedulePreparation.id,
          schedule: schedulePreparation.schedule,
          priceId: currentItem?.price.id ?? args.priceId,
          targetQuantity: args.quantity,
          prorationBehavior: "always_invoice",
        },
        signal,
      );
      return {
        ok: true,
        response: applied.response,
        subscription: applied.subscription,
      };
    }
    if (schedulePreparation.kind === "neutral") {
      await stripe.subscriptionSchedules.release(schedulePreparation.id, {
        preserve_cancel_date: true,
      });
      signal.throwIfAborted();
    }

    if (args.paymentMethod) {
      await setStripeSubscriptionPaymentMethod(
        stripe,
        subscription.id,
        args.paymentMethod,
        signal,
      );
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
      response: await appliedConcurrencyChangeResponse(
        stripe,
        updatedSubscription,
        args.quantity,
        signal,
      ),
      subscription: updatedSubscription,
    };
  },
);

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

async function listCompleteInvoiceLines(
  stripe: StripeClient,
  invoice: StripeInvoice,
  signal: AbortSignal,
): Promise<readonly StripeInvoiceLine[]> {
  if (!invoice.lines.has_more) {
    return invoice.lines.data;
  }
  const lines: StripeInvoiceLine[] = [];
  let startingAfter: string | undefined;
  while (true) {
    const page = await stripe.invoices.listLineItems(invoice.id, {
      limit: STRIPE_INVOICE_LINE_PAGE_SIZE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    signal.throwIfAborted();
    lines.push(...page.data);
    if (!page.has_more) {
      return lines;
    }
    const last = page.data.at(-1);
    if (!last?.id) {
      throw new Error(
        `Stripe invoice ${invoice.id} returned an incomplete line-item page`,
      );
    }
    startingAfter = last.id;
  }
}

function recurringConcurrencyAmount(
  invoice: StripeInvoice,
  lines: readonly StripeInvoiceLine[],
): number {
  const concurrencyLines = lines.filter((line) => {
    const priceId = invoiceLinePriceId(line);
    return priceId !== null && isConcurrencyPriceId(priceId);
  });
  const amount = concurrencyLines.reduce((total, line) => {
    return total + invoiceLineAmountWithTax(line);
  }, 0);
  if (
    invoice.currency.length !== 3 ||
    concurrencyLines.length === 0 ||
    !Number.isSafeInteger(amount) ||
    amount < 0
  ) {
    throw new Error(
      "Stripe concurrency recurring preview has an invalid amount",
    );
  }
  return amount;
}

function immediateProrationAmount(
  lines: readonly StripeInvoiceLine[],
  prorationTimestamp: number,
): number {
  const prorationLines = lines.filter((line) => {
    const priceId = invoiceLinePriceId(line);
    return (
      line.parent?.subscription_item_details?.proration === true &&
      line.period.start === prorationTimestamp &&
      priceId !== null &&
      isConcurrencyPriceId(priceId)
    );
  });
  const amount = prorationLines.reduce((total, line) => {
    return total + invoiceLineAmountWithTax(line);
  }, 0);
  if (prorationLines.length === 0 || !Number.isSafeInteger(amount)) {
    throw new Error("Stripe concurrency preview has an invalid amount");
  }
  return Math.max(0, amount);
}

async function concurrencyPreviewLines(
  stripe: StripeClient,
  immediatePreview: StripeInvoice,
  recurringPreview: StripeInvoice,
  signal: AbortSignal,
): Promise<
  readonly [readonly StripeInvoiceLine[], readonly StripeInvoiceLine[]]
> {
  if (immediatePreview.currency !== recurringPreview.currency) {
    throw new Error(
      "Stripe concurrency previews returned different currencies",
    );
  }
  const lines = await Promise.all([
    listCompleteInvoiceLines(stripe, immediatePreview, signal),
    listCompleteInvoiceLines(stripe, recurringPreview, signal),
  ]);
  signal.throwIfAborted();
  return lines;
}

interface StripeConcurrencySubscriptionPreviewArgs extends ConcurrencySubscriptionArgs {
  readonly priceId?: string;
  readonly quantity: number;
  readonly mode: "absolute" | "increase";
  readonly hasScheduledConcurrencyChange: boolean;
}

function previewTargetQuantity(
  currentQuantity: number,
  args: StripeConcurrencySubscriptionPreviewArgs,
): number {
  return args.mode === "increase"
    ? currentQuantity + args.quantity
    : args.quantity;
}

function concurrencyPreviewPriceId(
  item: StripeSubscriptionItem | undefined,
  args: StripeConcurrencySubscriptionPreviewArgs,
): string {
  const priceId = item?.price.id ?? args.priceId;
  if (!priceId) {
    throw new Error("Concurrency subscription has no active concurrency item");
  }
  return priceId;
}

interface DeferredConcurrencyPreviewArgs {
  readonly item: StripeSubscriptionItem;
  readonly currentQuantity: number;
  readonly targetQuantity: number;
  readonly recurringPreview: StripeInvoice;
  readonly recurringLines: readonly StripeInvoiceLine[];
}

function deferredConcurrencyPreviewResponse(
  args: DeferredConcurrencyPreviewArgs,
): PreviewConcurrencySubscriptionChangeResult {
  return {
    ok: true,
    preview: {
      currentQuantity: args.currentQuantity,
      targetQuantity: args.targetQuantity,
      immediateAmountCents: 0,
      nextRecurringAmountCents: recurringConcurrencyAmount(
        args.recurringPreview,
        args.recurringLines,
      ),
      currency: args.recurringPreview.currency,
      ...(args.targetQuantity < args.currentQuantity
        ? {
            effectiveAt: new Date(
              concurrencyItemPeriod(args.item).end * 1000,
            ).toISOString(),
          }
        : {}),
    },
  };
}

interface ScheduledConcurrencyPreview {
  readonly id: string;
  readonly item: StripeSubscriptionItem | null;
  readonly kind: "concurrency" | "usage_pack";
  readonly priceId: string;
  readonly schedule: StripeSubscriptionSchedule;
}

function concurrencyRecurringPreviewParams(
  subscription: StripeSubscription,
  items: StripeSubscriptionUpdateItemParam[],
  currentQuantity: number,
  targetQuantity: number,
  scheduledPreview: ScheduledConcurrencyPreview | null,
): StripeInvoiceCreatePreviewParams {
  if (!scheduledPreview) {
    return {
      subscription: subscription.id,
      preview_mode: "recurring",
      subscription_details: { items },
    };
  }
  if (
    scheduledPreview.kind === "usage_pack" &&
    targetQuantity > currentQuantity
  ) {
    return {
      schedule: scheduledPreview.id,
      preview_mode: "next",
      schedule_details: concurrencyScheduleMergeParams(
        scheduledPreview.schedule,
        scheduledPreview.priceId,
        targetQuantity,
        "none",
      ),
    };
  }
  if (!scheduledPreview.item) {
    throw new Error("Concurrency schedule has no active concurrency item");
  }
  return {
    schedule: scheduledPreview.id,
    preview_mode: "next",
    schedule_details: concurrencyScheduleUpdateParams(
      subscription,
      targetQuantity < currentQuantity ? scheduledPreview.schedule : null,
      targetQuantity,
      concurrencySchedulePeriod(
        scheduledPreview.item,
        scheduledPreview.schedule,
      ),
    ),
  };
}

type PreparedConcurrencySchedule =
  | { readonly ok: true; readonly kind: "none" }
  | { readonly ok: true; readonly kind: "neutral"; readonly id: string }
  | {
      readonly ok: true;
      readonly kind: "concurrency";
      readonly id: string;
      readonly schedule: StripeSubscriptionSchedule;
    }
  | {
      readonly ok: true;
      readonly kind: "usage_pack";
      readonly id: string;
      readonly schedule: StripeSubscriptionSchedule;
    }
  | { readonly ok: false };

type AvailableConcurrencySchedule = Exclude<
  PreparedConcurrencySchedule,
  { readonly ok: false }
>;

function isImmediateUsagePackSchedule(
  schedule: AvailableConcurrencySchedule,
  targetQuantity: number,
  currentQuantity: number,
): schedule is Extract<AvailableConcurrencySchedule, { kind: "usage_pack" }> {
  return schedule.kind === "usage_pack" && targetQuantity >= currentQuantity;
}

async function prepareConcurrencySchedule(
  db: ReadonlyDb,
  stripe: StripeClient,
  args: {
    readonly orgId: string;
    readonly subscription: StripeSubscription;
    readonly hasScheduledConcurrencyChange: boolean;
  },
  signal: AbortSignal,
): Promise<PreparedConcurrencySchedule> {
  const scheduleId = stripeObjectId(args.subscription.schedule);
  if (!scheduleId) {
    return { ok: true, kind: "none" };
  }
  const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
  signal.throwIfAborted();
  const owner = await concurrencyScheduleOwner(db, args.orgId, scheduleId);
  signal.throwIfAborted();
  if (owner === "plan") {
    return { ok: false };
  }
  if (owner === "usage_pack") {
    return { ok: true, kind: "usage_pack", id: scheduleId, schedule };
  }
  if (args.hasScheduledConcurrencyChange) {
    return { ok: true, kind: "concurrency", id: scheduleId, schedule };
  }
  return subscriptionScheduleHasNoFutureChanges(args.subscription, schedule)
    ? { ok: true, kind: "neutral", id: scheduleId }
    : { ok: false };
}

export const previewStripeConcurrencySubscriptionChange$ = command(
  async (
    { get },
    args: StripeConcurrencySubscriptionPreviewArgs,
    signal: AbortSignal,
  ): Promise<PreviewConcurrencySubscriptionChangeResult> => {
    const stripe = getStripeClient();
    const subscription = await stripe.subscriptions.retrieve(
      args.subscriptionId,
    );
    signal.throwIfAborted();
    const item = concurrencyPriceItem(subscription.items.data);
    const concurrencyPriceId = concurrencyPreviewPriceId(item, args);
    if (subscription.pending_update) {
      return { ok: false, reason: "pending_update" };
    }
    const currentQuantity = item?.quantity ?? 0;
    const targetQuantity = previewTargetQuantity(currentQuantity, args);
    if (
      !Number.isSafeInteger(targetQuantity) ||
      targetQuantity < 1 ||
      targetQuantity > CONCURRENCY_SUBSCRIPTION_QUANTITY_MAX
    ) {
      return { ok: false, reason: "invalid_quantity" };
    }
    const schedulePreparation = await prepareConcurrencySchedule(
      get(db$),
      stripe,
      {
        orgId: args.orgId,
        subscription,
        hasScheduledConcurrencyChange: args.hasScheduledConcurrencyChange,
      },
      signal,
    );
    if (!schedulePreparation.ok) {
      return { ok: false, reason: "pending_update" };
    }
    if (
      targetQuantity === currentQuantity &&
      !args.hasScheduledConcurrencyChange
    ) {
      return { ok: false, reason: "no_change" };
    }

    const prorationTimestamp = Math.floor(nowDate().getTime() / 1000);
    const items = [
      item
        ? { id: item.id, quantity: targetQuantity }
        : { price: args.priceId, quantity: targetQuantity },
    ];
    const scheduledPreview =
      schedulePreparation.kind === "concurrency" ||
      schedulePreparation.kind === "usage_pack"
        ? {
            id: schedulePreparation.id,
            item: item ?? null,
            kind: schedulePreparation.kind,
            priceId: concurrencyPriceId,
            schedule: schedulePreparation.schedule,
          }
        : null;
    const recurringPreviewParams = concurrencyRecurringPreviewParams(
      subscription,
      items,
      currentQuantity,
      targetQuantity,
      scheduledPreview,
    );
    const deferred = targetQuantity <= currentQuantity;
    if (deferred) {
      if (!item) {
        throw new Error(
          "Deferred concurrency change has no active concurrency item",
        );
      }
      const recurringPreview = await stripe.invoices.createPreview(
        recurringPreviewParams,
      );
      signal.throwIfAborted();
      const recurringLines = await listCompleteInvoiceLines(
        stripe,
        recurringPreview,
        signal,
      );
      return deferredConcurrencyPreviewResponse({
        item,
        currentQuantity,
        targetQuantity,
        recurringPreview,
        recurringLines,
      });
    }

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
      stripe.invoices.createPreview(recurringPreviewParams),
    ]);
    signal.throwIfAborted();
    const [immediateLines, recurringLines] = await concurrencyPreviewLines(
      stripe,
      immediatePreview,
      recurringPreview,
      signal,
    );

    return {
      ok: true,
      preview: {
        currentQuantity,
        targetQuantity,
        immediateAmountCents: immediateProrationAmount(
          immediateLines,
          prorationTimestamp,
        ),
        nextRecurringAmountCents: recurringConcurrencyAmount(
          recurringPreview,
          recurringLines,
        ),
        currency: recurringPreview.currency,
      },
    };
  },
);

function concurrencyChangeTargetQuantity(
  args: Pick<StripeConcurrencySubscriptionChangeArgs, "mode" | "quantity">,
  currentQuantity: number,
): number | null {
  const targetQuantity =
    args.mode === "increase" ? currentQuantity + args.quantity : args.quantity;
  if (
    !Number.isSafeInteger(targetQuantity) ||
    targetQuantity < 1 ||
    targetQuantity > CONCURRENCY_SUBSCRIPTION_QUANTITY_MAX ||
    (args.mode === "reduce" && targetQuantity > currentQuantity)
  ) {
    return null;
  }
  return targetQuantity;
}

export const applyStripeConcurrencySubscriptionChange$ = command(
  async (
    { get },
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
    const targetQuantity = concurrencyChangeTargetQuantity(args, item.quantity);
    if (targetQuantity === null) {
      return { ok: false, reason: "invalid_quantity" };
    }

    if (subscription.pending_update) {
      const pendingItem = concurrencySubscriptionItem(
        subscription.pending_update.subscription_items ?? [],
      );
      return pendingItem?.quantity === targetQuantity
        ? {
            ok: true,
            response: await appliedConcurrencyChangeResponse(
              stripe,
              subscription,
              targetQuantity,
              signal,
            ),
            subscription,
          }
        : { ok: false, reason: "pending_update" };
    }
    const schedulePreparation = await prepareConcurrencySchedule(
      get(db$),
      stripe,
      {
        orgId: args.orgId,
        subscription,
        hasScheduledConcurrencyChange: args.hasScheduledConcurrencyChange,
      },
      signal,
    );
    if (!schedulePreparation.ok) {
      return { ok: false, reason: "pending_update" };
    }
    if (
      targetQuantity === item.quantity &&
      !args.hasScheduledConcurrencyChange
    ) {
      return {
        ok: true,
        response: { status: "completed", hostedInvoiceUrl: null },
        subscription,
      };
    }

    if (
      isImmediateUsagePackSchedule(
        schedulePreparation,
        targetQuantity,
        item.quantity,
      )
    ) {
      const applied = await applyConcurrencyToUsagePackSchedule(
        stripe,
        {
          subscription,
          scheduleId: schedulePreparation.id,
          schedule: schedulePreparation.schedule,
          priceId: item.priceId,
          targetQuantity,
          prorationBehavior:
            targetQuantity > item.quantity ? "always_invoice" : "none",
        },
        signal,
      );
      return {
        ok: true,
        response: applied.response,
        subscription: applied.subscription,
      };
    }

    if (targetQuantity < item.quantity) {
      const effectiveAt = await scheduleConcurrencyChange(
        subscription,
        targetQuantity,
        signal,
      );
      return {
        ok: true,
        response: {
          status: "completed",
          hostedInvoiceUrl: null,
          effectiveAt: effectiveAt.toISOString(),
        },
        subscription,
      };
    }

    if (schedulePreparation.kind !== "none") {
      await stripe.subscriptionSchedules.release(schedulePreparation.id, {
        preserve_cancel_date: true,
      });
      signal.throwIfAborted();
    }

    if (targetQuantity === item.quantity) {
      return {
        ok: true,
        response: { status: "completed", hostedInvoiceUrl: null },
        subscription: { ...subscription, schedule: null },
      };
    }

    if (args.paymentMethod) {
      await setStripeSubscriptionPaymentMethod(
        stripe,
        subscription.id,
        args.paymentMethod,
        signal,
      );
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
      response: await appliedConcurrencyChangeResponse(
        stripe,
        updatedSubscription,
        targetQuantity,
        signal,
      ),
      subscription: updatedSubscription,
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
    return await set(
      previewStripeConcurrencySubscriptionChange$,
      {
        ...args,
        mode: "absolute",
        hasScheduledConcurrencyChange: subscription.scheduledQuantity !== null,
      },
      signal,
    );
  },
);

export const changeConcurrencySubscription$ = command(
  async (
    { get, set },
    args: ConfirmedConcurrencySubscriptionChangeArgs,
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
    const result = await set(
      applyStripeConcurrencySubscriptionChange$,
      {
        orgId: args.orgId,
        subscriptionId: args.subscriptionId,
        quantity: args.quantity,
        mode: "absolute",
        hasScheduledConcurrencyChange: subscription.scheduledQuantity !== null,
        paymentMethod: args.paymentMethod,
      },
      signal,
    );
    if (result.ok) {
      if (result.response.status === "checkout_required") {
        throw new Error(
          "Stripe concurrency change unexpectedly required Checkout",
        );
      }
      const scheduled =
        args.quantity < subscription.quantity &&
        result.response.effectiveAt !== undefined;
      await writeScheduledConcurrencyChange(set(writeDb$), {
        orgId: args.orgId,
        subscriptionId: args.subscriptionId,
        quantity: scheduled ? args.quantity : null,
        effectiveAt: scheduled ? (result.response.effectiveAt ?? null) : null,
      });
      signal.throwIfAborted();
    }
    return result;
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
    if (await isSharedBillingSubscription(get(db$), args)) {
      const stripeSubscription = await stripe.subscriptions.retrieve(
        args.subscriptionId,
      );
      signal.throwIfAborted();
      if (
        stripeObjectId(stripeSubscription.schedule) !== null &&
        subscription.scheduledQuantity === null &&
        !subscription.cancelAtPeriodEnd
      ) {
        const scheduleId = stripeObjectId(stripeSubscription.schedule);
        if (!scheduleId) {
          throw new Error("Stripe subscription schedule disappeared");
        }
        const schedule =
          await stripe.subscriptionSchedules.retrieve(scheduleId);
        signal.throwIfAborted();
        if (
          !subscriptionScheduleHasNoFutureChanges(stripeSubscription, schedule)
        ) {
          return { ok: false, reason: "pending_update" };
        }
      }
      await scheduleConcurrencyChange(stripeSubscription, 0, signal);
    } else {
      await stripe.subscriptions.update(args.subscriptionId, {
        cancel_at_period_end: true,
      });
    }
    signal.throwIfAborted();

    await set(writeDb$)
      .update(orgConcurrencySubscriptions)
      .set({
        cancelAtPeriodEnd: true,
        scheduledSlots: null,
        scheduledChangeAt: null,
        updatedAt: nowDate(),
      })
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
        orgId: args.orgId,
        subscriptionId: args.subscriptionId,
        quantity: args.quantity,
        mode: "reduce",
        hasScheduledConcurrencyChange: subscription.scheduledQuantity !== null,
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
    if (result.response.status === "checkout_required") {
      throw new Error(
        "Stripe concurrency reduction unexpectedly required Checkout",
      );
    }
    await writeScheduledConcurrencyChange(set(writeDb$), {
      orgId: args.orgId,
      subscriptionId: args.subscriptionId,
      quantity: args.quantity,
      effectiveAt: result.response.effectiveAt ?? null,
    });
    signal.throwIfAborted();
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
    if (!subscription || !subscription.cancelAtPeriodEnd) {
      return { ok: false, reason: "not_found" };
    }

    const stripe = getStripeClient();
    if (await isSharedBillingSubscription(get(db$), args)) {
      const stripeSubscription = await stripe.subscriptions.retrieve(
        args.subscriptionId,
      );
      signal.throwIfAborted();
      const scheduleId = stripeObjectId(stripeSubscription.schedule);
      if (!scheduleId) {
        throw new Error(
          "Canceling shared concurrency subscription has no schedule",
        );
      }
      // Cancellation can create this schedule only when no other subscription
      // update is pending. Releasing it restores the current items and keeps
      // later concurrency changes from treating the canceled change as foreign.
      await stripe.subscriptionSchedules.release(scheduleId, {
        preserve_cancel_date: true,
      });
    } else {
      await stripe.subscriptions.update(args.subscriptionId, {
        cancel_at_period_end: false,
      });
    }
    signal.throwIfAborted();

    await set(writeDb$)
      .update(orgConcurrencySubscriptions)
      .set({
        cancelAtPeriodEnd: false,
        scheduledSlots: null,
        scheduledChangeAt: null,
        updatedAt: nowDate(),
      })
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
