import { isDeepStrictEqual } from "node:util";

import {
  getStripeClient,
  type StripeRef,
  type StripeSchedulePhase,
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

function stripeRefId(ref: StripeRef): string | null {
  return typeof ref === "string" ? ref : (ref?.id ?? null);
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
