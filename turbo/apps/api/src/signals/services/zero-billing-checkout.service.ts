import { command } from "ccstate";
import type { Stripe } from "stripe";

import { env } from "../../lib/env";
import { getStripeClient } from "../external/stripe-client";
import { getOrCreateStripeCustomer$ } from "./billing-customer.service";

interface CreateCheckoutSessionArgs {
  readonly orgId: string;
  readonly priceId: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

interface CreateCreditCheckoutSessionArgs {
  readonly orgId: string;
  readonly credits: number;
  readonly customAmount?: boolean;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

const CREDITS_PER_DOLLAR = 1000;

/** Returns the active (first) price ID for a given tier. */
export function activePriceId(tier: "pro" | "team"): string | undefined {
  return env("ZERO_PRICE")?.[tier]?.[0];
}

export function activeCustomCreditPriceId(): string | undefined {
  return env("ZERO_PRICE")?.customCredits?.[0];
}

function customUnitAmountParams(
  template: Stripe.Price.CustomUnitAmount | null,
  preset: number,
): Stripe.PriceCreateParams.CustomUnitAmount {
  return {
    enabled: true,
    preset,
    ...(template?.minimum === null || template?.minimum === undefined
      ? {}
      : { minimum: template.minimum }),
    ...(template?.maximum === null || template?.maximum === undefined
      ? {}
      : { maximum: template.maximum }),
  };
}

async function createPresetCustomCreditPrice(
  stripe: ReturnType<typeof getStripeClient>,
  templatePriceId: string,
  presetAmountCents: number,
): Promise<string> {
  const templatePrice = await stripe.prices.retrieve(templatePriceId);
  const productId =
    typeof templatePrice.product === "string"
      ? templatePrice.product
      : templatePrice.product.id;
  const customPrice = await stripe.prices.create({
    currency: templatePrice.currency,
    product: productId,
    custom_unit_amount: customUnitAmountParams(
      templatePrice.custom_unit_amount,
      presetAmountCents,
    ),
  });
  return customPrice.id;
}

/**
 * Create a Stripe Checkout session for subscription. Returns the
 * checkout session URL. Mirrors apps/web's createCheckoutSession
 * (allow_promotion_codes + subscription metadata orgId tag).
 */
export const createCheckoutSession$ = command(
  async (
    { set },
    args: CreateCheckoutSessionArgs,
    signal: AbortSignal,
  ): Promise<string> => {
    const customerId = await set(
      getOrCreateStripeCustomer$,
      args.orgId,
      signal,
    );
    signal.throwIfAborted();

    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: args.priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      subscription_data: { metadata: { orgId: args.orgId } },
    });
    signal.throwIfAborted();

    if (!session.url) {
      throw new Error("Stripe checkout session did not return a URL");
    }
    return session.url;
  },
);

export const createCreditCheckoutSession$ = command(
  async (
    { set },
    args: CreateCreditCheckoutSessionArgs,
    signal: AbortSignal,
  ): Promise<string> => {
    const customerId = await set(
      getOrCreateStripeCustomer$,
      args.orgId,
      signal,
    );
    signal.throwIfAborted();

    const stripe = getStripeClient();
    const baseMetadata = {
      purpose: "credit_purchase",
      orgId: args.orgId,
    };
    let metadata: Stripe.MetadataParam;
    let lineItems: Stripe.Checkout.SessionCreateParams.LineItem[];
    if (args.customAmount === true) {
      const customCreditPriceId = activeCustomCreditPriceId();
      if (!customCreditPriceId) {
        throw new Error("Custom credit price not configured");
      }
      const presetAmountCents =
        Math.ceil(args.credits / CREDITS_PER_DOLLAR) * 100;
      const presetPriceId = await createPresetCustomCreditPrice(
        stripe,
        customCreditPriceId,
        presetAmountCents,
      );
      signal.throwIfAborted();
      metadata = {
        ...baseMetadata,
        creditsAmountMode: "amount_total",
        requestedCreditsAmount: String(args.credits),
      };
      lineItems = [{ price: presetPriceId, quantity: 1 }];
    } else {
      metadata = { ...baseMetadata, creditsAmount: String(args.credits) };
      lineItems = [
        {
          price_data: {
            currency: "usd",
            unit_amount: Math.ceil(args.credits / CREDITS_PER_DOLLAR) * 100,
            product_data: {
              name: `${args.credits.toLocaleString()} Zero credits`,
            },
          },
          quantity: 1,
        },
      ];
    }
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: customerId,
      line_items: lineItems,
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      payment_intent_data: {
        setup_future_usage: "off_session",
        metadata: {
          type: "credit_purchase",
          ...metadata,
        },
      },
      metadata,
    });
    signal.throwIfAborted();

    if (!session.url) {
      throw new Error("Stripe checkout session did not return a URL");
    }
    return session.url;
  },
);
