import type { Stripe } from "stripe";
import { command } from "ccstate";
import { webhookStripeContract } from "@vm0/api-contracts/contracts/webhooks";

import { optionalEnv } from "../../lib/env";
import type { RouteEntry } from "../route";
import { request$ } from "../context/hono";
import { getStripeClient } from "../external/stripe-client";
import { settle } from "../utils";
import { handleStripeWebhookEvent$ } from "../services/webhooks-stripe.service";

function jsonError(message: string, status: 401 | 503): Response {
  return Response.json({ error: message }, { status });
}

const postStripeWebhook$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const webhookSecret = optionalEnv("STRIPE_WEBHOOK_SECRET");
    if (!webhookSecret) {
      return jsonError("Stripe billing is not configured", 503);
    }

    const request = get(request$);
    const signature = request.raw.headers.get("stripe-signature");
    if (!signature) {
      return jsonError("Missing stripe-signature header", 401);
    }

    const body = await request.text();
    signal.throwIfAborted();

    // constructEvent is a sync verifier that throws on bad signatures —
    // wrap in an async IIFE so the throw becomes a rejection settle can
    // observe instead of escaping. The Promise.resolve() await is just
    // there to satisfy require-await; the microtask hop is harmless.
    const eventResult = await settle(
      (async (): Promise<Stripe.Event> => {
        await Promise.resolve();
        return getStripeClient().webhooks.constructEvent(
          body,
          signature,
          webhookSecret,
        );
      })(),
    );
    signal.throwIfAborted();
    if (!eventResult.ok) {
      return jsonError("Invalid webhook signature", 401);
    }

    const event = eventResult.value;
    await set(handleStripeWebhookEvent$, event, signal);
    signal.throwIfAborted();

    return new Response("OK", { status: 200 });
  },
);

export const webhooksStripeRoutes: readonly RouteEntry[] = [
  {
    route: webhookStripeContract.post,
    handler: postStripeWebhook$,
  },
];
