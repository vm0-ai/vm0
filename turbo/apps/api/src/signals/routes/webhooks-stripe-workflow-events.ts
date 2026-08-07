import { webhookStripeWorkflowEventsContract } from "@vm0/api-contracts/contracts/webhooks";
import { command } from "ccstate";

import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { request$ } from "../context/hono";
import { constructStripeWebhookEvent } from "../external/stripe-client";
import type { RouteEntry } from "../route-entry";
import { dispatchStripeWorkflowEvent$ } from "../services/stripe-workflow-event.service";
import { safeSync, settle } from "../utils";

const log = logger("api:webhooks-stripe-workflow-events");

function jsonError(message: string, status: 400 | 401 | 500 | 503): Response {
  return Response.json({ error: message }, { status });
}

const postStripeWorkflowEvent$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const webhookSecret = optionalEnv("STRIPE_WORKFLOW_WEBHOOK_SECRET");
    if (!webhookSecret) {
      return jsonError("Stripe workflow events are not configured", 503);
    }

    const request = get(request$);
    const signature = request.raw.headers.get("stripe-signature");
    if (!signature) {
      return jsonError("Missing stripe-signature header", 401);
    }
    const rawBody = await request.text();
    signal.throwIfAborted();
    const constructed = safeSync(() => {
      return constructStripeWebhookEvent(rawBody, signature, webhookSecret);
    });
    signal.throwIfAborted();
    if ("error" in constructed) {
      return jsonError("Invalid webhook signature", 401);
    }

    const dispatched = await settle(
      set(dispatchStripeWorkflowEvent$, constructed.ok, signal),
      signal,
    );
    if (!dispatched.ok) {
      log.error("Stripe workflow ingress transaction failed", {
        category: "ingress_transaction",
      });
      return jsonError("Stripe workflow event processing failed", 500);
    }
    if (dispatched.value.kind === "bad_request") {
      return jsonError("Invalid supported Stripe workflow event", 400);
    }
    return new Response("OK", { status: 200 });
  },
);

export const webhooksStripeWorkflowEventsRoutes: readonly RouteEntry[] = [
  {
    route: webhookStripeWorkflowEventsContract.post,
    handler: postStripeWorkflowEvent$,
  },
];
