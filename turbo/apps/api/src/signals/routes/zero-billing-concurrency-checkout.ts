import { command } from "ccstate";
import { zeroBillingConcurrencyCheckoutContract } from "@vm0/api-contracts/contracts/zero-billing";

import { optionalEnv } from "../../lib/env";
import { billingRedirectAllowed } from "../../lib/billing-redirect";
import { badRequestMessage, providerUnavailable } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import {
  activeConcurrencyPriceId,
  createConcurrencyCheckoutSession$,
} from "../services/zero-billing-checkout.service";
import type { RouteEntry } from "../route";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can buy concurrency",
      code: "FORBIDDEN",
    }),
  }),
});

const concurrencyCheckoutAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    signal.throwIfAborted();

    const bodyResult = await get(
      bodyResultOf(zeroBillingConcurrencyCheckoutContract.create),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const { quantity, successUrl, cancelUrl } = bodyResult.data;

    if (
      !billingRedirectAllowed(successUrl) ||
      !billingRedirectAllowed(cancelUrl)
    ) {
      return badRequestMessage(
        "successUrl and cancelUrl must match the platform origin",
      );
    }

    const priceId = activeConcurrencyPriceId();
    if (!priceId) {
      return badRequestMessage("Concurrency price not configured");
    }

    const url = await set(
      createConcurrencyCheckoutSession$,
      {
        orgId: auth.orgId,
        quantity,
        priceId,
        successUrl,
        cancelUrl,
      },
      signal,
    );
    signal.throwIfAborted();

    return { status: 200 as const, body: { url } };
  },
);

const concurrencyCheckout$ = command(async ({ set }, signal: AbortSignal) => {
  if (!optionalEnv("STRIPE_SECRET_KEY")) {
    return providerUnavailable("Billing not configured");
  }

  return await set(
    authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "billing:write",
      },
      concurrencyCheckoutAuthed$,
    ),
    signal,
  );
});

export const zeroBillingConcurrencyCheckoutRoutes: readonly RouteEntry[] = [
  {
    route: zeroBillingConcurrencyCheckoutContract.create,
    handler: concurrencyCheckout$,
  },
];
