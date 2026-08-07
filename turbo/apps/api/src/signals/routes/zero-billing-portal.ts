import { command } from "ccstate";
import { zeroBillingPortalContract } from "@vm0/api-contracts/contracts/zero-billing";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { optionalEnv } from "../../lib/env";
import { billingRedirectAllowed } from "../../lib/billing-redirect";
import { badRequestMessage, providerUnavailable } from "../../lib/error";
import { createBillingPortalSession$ } from "../services/billing.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import type { RouteEntry } from "../route-entry";

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

  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  const paymentMethodManagementEnabled = isFeatureEnabled(
    FeatureSwitchKey.PaymentMethodManagement,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      overrides,
    },
  );

  const bodyResult = await get(bodyResultOf(zeroBillingPortalContract.create));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const { returnUrl } = bodyResult.data;

  if (!billingRedirectAllowed(returnUrl)) {
    return badRequestMessage("returnUrl must match the platform origin");
  }

  const url = await set(
    createBillingPortalSession$,
    { orgId: auth.orgId, returnUrl, paymentMethodManagementEnabled },
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
