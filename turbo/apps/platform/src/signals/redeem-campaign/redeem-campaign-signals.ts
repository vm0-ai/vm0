import { command, computed, state } from "ccstate";
import type { RedeemResponse } from "@vm0/core/contracts/zero-billing";

/**
 * The current response from the redeem API. `null` during the initial fetch
 * and for the `?stripe=success` branch; populated before `hideAppSkeleton$`
 * fires so the view never has to render a loading state of its own.
 */
const internalRedeemResponse$ = state<RedeemResponse | null>(null);

/**
 * True when the page was loaded with `?stripe=success`. Set before the API
 * is skipped — Stripe's success_url hits this page with no need to recheck
 * server-side state, since the actual credit grant is driven by the webhook.
 */
const internalRedeemStripeSuccess$ = state(false);

export const redeemResponse$ = computed((get) => {
  return get(internalRedeemResponse$);
});

export const redeemStripeSuccess$ = computed((get) => {
  return get(internalRedeemStripeSuccess$);
});

export const setRedeemResponse$ = command(
  ({ set }, response: RedeemResponse | null) => {
    set(internalRedeemResponse$, response);
  },
);

export const setRedeemStripeSuccess$ = command(({ set }, value: boolean) => {
  set(internalRedeemStripeSuccess$, value);
});
