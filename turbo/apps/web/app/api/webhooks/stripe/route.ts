import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import { getStripe } from "../../../../src/lib/zero/stripe";
import {
  handleCheckoutCompleted,
  handleInvoicePaid,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
} from "../../../../src/lib/zero/billing/billing-service";
import { logger } from "../../../../src/lib/shared/logger";
import type Stripe from "stripe";

const log = logger("webhook:stripe");

/**
 * Stripe Webhook Endpoint
 *
 * POST /api/webhooks/stripe
 *
 * Handles incoming Stripe webhook events:
 * - checkout.session.completed — subscription activated
 * - checkout.session.async_payment_succeeded — delayed one-time payment settled
 * - invoice.paid — grant monthly credits
 * - customer.subscription.updated — sync status/tier changes
 * - customer.subscription.deleted — downgrade to free
 */
export async function POST(request: Request) {
  initServices();

  const { STRIPE_WEBHOOK_SECRET } = env();

  if (!STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json(
      { error: "Stripe billing is not configured" },
      { status: 503 },
    );
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 401 },
    );
  }

  // Get raw body for signature verification
  const body = await request.text();

  let event: Stripe.Event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    return NextResponse.json(
      { error: "Invalid webhook signature" },
      { status: 401 },
    );
  }

  log.info("stripe webhook received", { type: event.type, id: event.id });

  // Handlers run before the response so that failures return a non-200 status,
  // allowing Stripe to retry on transient errors (e.g. database outages).
  // Stripe.Event is a discriminated union — narrowing on `type` gives the
  // correct `data.object` type without explicit casts.
  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutCompleted(event.data.object);
      break;
    case "checkout.session.async_payment_succeeded":
      await handleCheckoutCompleted(event.data.object);
      break;
    case "invoice.paid":
      await handleInvoicePaid(event.data.object);
      break;
    case "customer.subscription.updated":
      await handleSubscriptionUpdated(event.data.object);
      break;
    case "customer.subscription.deleted":
      await handleSubscriptionDeleted(event.data.object);
      break;
    default:
      log.debug("ignoring unhandled Stripe event", { type: event.type });
  }

  return new Response("OK", { status: 200 });
}
