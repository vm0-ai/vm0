import { command } from "ccstate";
import { zeroBillingPortalContract } from "@vm0/api-contracts/contracts/zero-billing";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { env, optionalEnv } from "../../lib/env";
import { badRequestMessage, providerUnavailable } from "../../lib/error";
import { createBillingPortalSession$ } from "../services/billing.service";
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

const portalInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!optionalEnv("STRIPE_SECRET_KEY")) {
    return providerUnavailable("Billing not configured");
  }

  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }

  const bodyResult = await get(bodyResultOf(zeroBillingPortalContract.create));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const { returnUrl } = bodyResult.data;

  const appOrigin = new URL(env("APP_URL")).origin;
  if (new URL(returnUrl).origin !== appOrigin) {
    return badRequestMessage("returnUrl must match the platform origin");
  }

  const url = await set(
    createBillingPortalSession$,
    { orgId: auth.orgId, returnUrl },
    signal,
  );
  signal.throwIfAborted();

  return { status: 200 as const, body: { url } };
});

export const zeroBillingPortalRoutes: readonly RouteEntry[] = [
  {
    route: zeroBillingPortalContract.create,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      portalInner$,
    ),
  },
];
