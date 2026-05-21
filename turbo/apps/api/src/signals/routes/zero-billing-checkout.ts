import { command } from "ccstate";
import { zeroBillingCheckoutContract } from "@vm0/api-contracts/contracts/zero-billing";

import { env, optionalEnv } from "../../lib/env";
import { badRequestMessage, providerUnavailable } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import {
  activePriceId,
  createCheckoutSession$,
} from "../services/zero-billing-checkout.service";
import type { RouteEntry } from "../route";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can manage billing",
      code: "FORBIDDEN",
    }),
  }),
});

const checkoutAuthed$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }
  signal.throwIfAborted();

  const bodyResult = await get(
    bodyResultOf(zeroBillingCheckoutContract.create),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const { tier, successUrl, cancelUrl } = bodyResult.data;

  const appOrigin = new URL(env("APP_URL")).origin;
  if (
    new URL(successUrl).origin !== appOrigin ||
    new URL(cancelUrl).origin !== appOrigin
  ) {
    return badRequestMessage(
      "successUrl and cancelUrl must match the platform origin",
    );
  }

  const priceId = activePriceId(tier);
  if (!priceId) {
    return badRequestMessage(`Price not configured for ${tier} tier`);
  }

  const url = await set(
    createCheckoutSession$,
    { orgId: auth.orgId, priceId, successUrl, cancelUrl },
    signal,
  );
  signal.throwIfAborted();
  return { status: 200 as const, body: { url } };
});

const checkout$ = command(async ({ set }, signal: AbortSignal) => {
  if (!optionalEnv("STRIPE_SECRET_KEY")) {
    return providerUnavailable("Billing not configured");
  }

  return await set(
    authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      checkoutAuthed$,
    ),
    signal,
  );
});

export const zeroBillingCheckoutRoutes: readonly RouteEntry[] = [
  {
    route: zeroBillingCheckoutContract.create,
    handler: checkout$,
  },
];
