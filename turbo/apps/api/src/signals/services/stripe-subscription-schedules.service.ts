import { isDeepStrictEqual } from "node:util";

import {
  getStripeClient,
  type StripeRef,
  type StripeSchedulePhase,
  type StripeSchedulePhaseDiscountParam,
  type StripeSchedulePhaseItemParam,
  type StripeSchedulePhaseParam,
  type StripeSubscription,
  type StripeSubscriptionSchedule,
} from "../external/stripe-client";

interface SubscriptionScheduleRef {
  readonly schedule?: string | { readonly id: string } | null;
}

export function subscriptionScheduleId(
  subscription: SubscriptionScheduleRef,
): string | null {
  const schedule = subscription.schedule;
  if (typeof schedule === "string") {
    return schedule;
  }
  return schedule?.id ?? null;
}

export function subscriptionScheduleFinalEnd(
  schedule: Pick<StripeSubscriptionSchedule, "current_phase" | "phases">,
): Date | null {
  const finalEnd = schedule.phases.reduce<number | null>((latest, phase) => {
    return latest === null || phase.end_date > latest ? phase.end_date : latest;
  }, schedule.current_phase?.end_date ?? null);

  return finalEnd === null ? null : new Date(finalEnd * 1000);
}

function stripeRefId(ref: StripeRef | undefined): string | null {
  return typeof ref === "string" ? ref : (ref?.id ?? null);
}

function scheduleDiscountParam(
  discount: NonNullable<StripeSchedulePhase["discounts"]>[number],
): StripeSchedulePhaseDiscountParam {
  const discountId = stripeRefId(discount.discount);
  if (discountId) {
    return { discount: discountId };
  }
  const couponId = stripeRefId(discount.coupon);
  if (couponId) {
    return { coupon: couponId };
  }
  const promotionCodeId = stripeRefId(discount.promotion_code);
  if (promotionCodeId) {
    return { promotion_code: promotionCodeId };
  }
  throw new Error("Stripe subscription schedule has an invalid discount");
}

function schedulePhaseItemParam(
  item: NonNullable<StripeSchedulePhase["items"]>[number],
): StripeSchedulePhaseItemParam {
  const price = stripeRefId(item.price);
  const quantity = item.quantity ?? 1;
  if (!price || !Number.isSafeInteger(quantity) || quantity < 1) {
    throw new Error("Stripe subscription schedule has an invalid item");
  }
  const discounts = (item.discounts ?? []).map(scheduleDiscountParam);
  const taxRates = (item.tax_rates ?? []).map((taxRate) => {
    const id = stripeRefId(taxRate);
    if (!id) {
      throw new Error("Stripe subscription schedule has an invalid tax rate");
    }
    return id;
  });
  return {
    price,
    quantity,
    ...(discounts.length > 0 ? { discounts } : {}),
    ...(item.metadata ? { metadata: { ...item.metadata } } : {}),
    ...(taxRates.length > 0 ? { tax_rates: taxRates } : {}),
  };
}

function schedulePhaseParam(
  phase: StripeSchedulePhase,
  endDate: number,
): StripeSchedulePhaseParam {
  const items = phase.items?.map(schedulePhaseItemParam);
  if (!items || items.length === 0 || endDate <= phase.start_date) {
    throw new Error("Stripe subscription schedule has an invalid phase");
  }
  const discounts = (phase.discounts ?? []).map(scheduleDiscountParam);
  return {
    start_date: phase.start_date,
    end_date: endDate,
    ...(phase.currency ? { currency: phase.currency } : {}),
    items,
    ...(phase.metadata ? { metadata: { ...phase.metadata } } : {}),
    proration_behavior: phase.proration_behavior ?? "none",
    ...(discounts.length > 0 ? { discounts } : {}),
  };
}

export function subscriptionSchedulePhasesEndingAt(
  schedule: Pick<StripeSubscriptionSchedule, "current_phase" | "phases">,
  endDate: number,
): readonly StripeSchedulePhaseParam[] {
  const currentPhase = schedule.current_phase;
  if (!currentPhase) {
    throw new Error("Stripe subscription schedule has no current phase");
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
  const phases = schedule.phases.slice(currentPhaseIndex).filter((phase) => {
    return phase.start_date < endDate;
  });
  const finalPhase = phases[phases.length - 1];
  if (
    !finalPhase ||
    endDate > finalPhase.end_date ||
    phases.some((phase) => {
      return (phase.add_invoice_items?.length ?? 0) > 0;
    })
  ) {
    throw new Error("Stripe subscription schedule cannot end at this date");
  }
  return phases.map((phase) => {
    return schedulePhaseParam(phase, Math.min(phase.end_date, endDate));
  });
}

function schedulePhaseSettings(
  phase: StripeSchedulePhase,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(phase).filter(([key]) => {
      return !["start_date", "end_date", "items", "discounts"].includes(key);
    }),
  );
}

function normalizedScheduleItems(
  items: StripeSchedulePhase["items"],
): readonly { readonly price: string; readonly quantity: number }[] | null {
  if (!items) {
    return null;
  }
  const normalized = items.flatMap((item) => {
    const price = stripeRefId(item.price);
    const quantity = item.quantity ?? 1;
    return price && Number.isSafeInteger(quantity) && quantity > 0
      ? [{ price, quantity }]
      : [];
  });
  if (normalized.length !== items.length) {
    return null;
  }
  return normalized.sort((left, right) => {
    return left.price.localeCompare(right.price);
  });
}

function normalizedScheduleItemConfigurations(
  items: StripeSchedulePhase["items"],
):
  | readonly {
      readonly price: string;
      readonly quantity: number;
      readonly settings: Readonly<Record<string, unknown>>;
    }[]
  | null {
  if (!items) {
    return null;
  }
  const normalized = items.flatMap((item) => {
    const price = stripeRefId(item.price);
    const quantity = item.quantity ?? 1;
    if (!price || !Number.isSafeInteger(quantity) || quantity <= 0) {
      return [];
    }
    return [
      {
        price,
        quantity,
        settings: Object.fromEntries(
          Object.entries(item).filter(([key]) => {
            return key !== "price" && key !== "quantity";
          }),
        ),
      },
    ];
  });
  if (normalized.length !== items.length) {
    return null;
  }
  return normalized.sort((left, right) => {
    return left.price.localeCompare(right.price);
  });
}

function normalizedSubscriptionItems(
  subscription: StripeSubscription,
): readonly { readonly price: string; readonly quantity: number }[] | null {
  const normalized = subscription.items.data.flatMap((item) => {
    const quantity = item.quantity ?? 1;
    return Number.isSafeInteger(quantity) && quantity > 0
      ? [{ price: item.price.id, quantity }]
      : [];
  });
  if (normalized.length !== subscription.items.data.length) {
    return null;
  }
  return normalized.sort((left, right) => {
    return left.price.localeCompare(right.price);
  });
}

function normalizedScheduleDiscounts(
  discounts: StripeSchedulePhase["discounts"],
): readonly string[] | null {
  const normalized = (discounts ?? []).flatMap((discount) => {
    const id = stripeRefId(discount.discount);
    return id ? [id] : [];
  });
  if (normalized.length !== (discounts?.length ?? 0)) {
    return null;
  }
  return normalized.sort();
}

function normalizedSubscriptionDiscounts(
  discounts: readonly StripeRef[] | undefined,
): readonly string[] | null {
  const normalized = (discounts ?? []).flatMap((discount) => {
    const id = stripeRefId(discount);
    return id ? [id] : [];
  });
  if (normalized.length !== (discounts?.length ?? 0)) {
    return null;
  }
  return normalized.sort();
}

/**
 * Returns true only when an attached schedule preserves the subscription's
 * current billing configuration in every remaining phase.
 */
export function subscriptionScheduleHasNoFutureChanges(
  subscription: StripeSubscription,
  schedule: StripeSubscriptionSchedule,
): boolean {
  const currentPhaseRef = schedule.current_phase;
  if (schedule.end_behavior !== "release" || !currentPhaseRef) {
    return false;
  }
  const currentPhase = schedule.phases.find((phase) => {
    return (
      phase.start_date === currentPhaseRef.start_date &&
      phase.end_date === currentPhaseRef.end_date
    );
  });
  if (!currentPhase) {
    return false;
  }
  const currentItems = normalizedScheduleItems(currentPhase.items);
  const currentItemConfigurations = normalizedScheduleItemConfigurations(
    currentPhase.items,
  );
  const subscriptionItems = normalizedSubscriptionItems(subscription);
  const currentDiscounts = normalizedScheduleDiscounts(currentPhase.discounts);
  const subscriptionDiscounts = normalizedSubscriptionDiscounts(
    subscription.discounts,
  );
  if (
    !currentItems ||
    !currentItemConfigurations ||
    !subscriptionItems ||
    !currentDiscounts ||
    !subscriptionDiscounts ||
    !isDeepStrictEqual(currentItems, subscriptionItems) ||
    !isDeepStrictEqual(currentDiscounts, subscriptionDiscounts)
  ) {
    return false;
  }
  const currentSettings = schedulePhaseSettings(currentPhase);
  return schedule.phases
    .filter((phase) => {
      return phase.start_date >= currentPhase.start_date;
    })
    .every((phase) => {
      return (
        (phase.start_date === currentPhase.start_date ||
          (phase.add_invoice_items?.length ?? 0) === 0) &&
        isDeepStrictEqual(normalizedScheduleItems(phase.items), currentItems) &&
        isDeepStrictEqual(
          normalizedScheduleItemConfigurations(phase.items),
          currentItemConfigurations,
        ) &&
        isDeepStrictEqual(
          normalizedScheduleDiscounts(phase.discounts),
          currentDiscounts,
        ) &&
        isDeepStrictEqual(schedulePhaseSettings(phase), currentSettings)
      );
    });
}

export async function subscriptionScheduleCancellationEnd(
  stripe: ReturnType<typeof getStripeClient>,
  subscription: SubscriptionScheduleRef,
): Promise<Date | null> {
  const scheduleId = subscriptionScheduleId(subscription);
  if (!scheduleId) {
    return null;
  }

  const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
  if (schedule.end_behavior !== "cancel") {
    return null;
  }

  return subscriptionScheduleFinalEnd(schedule);
}
