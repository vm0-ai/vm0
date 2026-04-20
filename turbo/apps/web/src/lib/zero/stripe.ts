import Stripe from "stripe";

/**
 * Get the Stripe client from globalThis.services.
 * Requires initServices() to have been called first.
 */
export function getStripe(): Stripe {
  return globalThis.services.stripe;
}
