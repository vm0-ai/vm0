import Stripe from "stripe";
import { env } from "../env";

let _stripe: Stripe | undefined;

export function getStripe(): Stripe {
  if (!_stripe) {
    const key = env().STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is required for billing");
    _stripe = new Stripe(key);
  }
  return _stripe;
}
