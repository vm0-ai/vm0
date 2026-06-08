import type { Stripe } from "stripe";

import { getStripeClient } from "../external/stripe-client";

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
  schedule: Pick<Stripe.SubscriptionSchedule, "current_phase" | "phases">,
): Date | null {
  const finalEnd = schedule.phases.reduce<number | null>((latest, phase) => {
    return latest === null || phase.end_date > latest ? phase.end_date : latest;
  }, schedule.current_phase?.end_date ?? null);

  return finalEnd === null ? null : new Date(finalEnd * 1000);
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
