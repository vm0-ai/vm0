import { command } from "ccstate";
import { zeroBillingDowngradeContract } from "@vm0/api-contracts/contracts/zero-billing";

import { optionalEnv } from "../../lib/env";
import {
  badRequestMessage,
  conflict,
  providerUnavailable,
} from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { downgradeSubscription$ } from "../services/zero-billing-downgrade.service";
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

const downgradeAuthed$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }
  signal.throwIfAborted();

  const bodyResult = await get(
    bodyResultOf(zeroBillingDowngradeContract.create),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const { targetTier } = bodyResult.data;

  const result = await set(
    downgradeSubscription$,
    { orgId: auth.orgId, targetTier },
    signal,
  );
  signal.throwIfAborted();

  if (!result.ok) {
    if (result.reason === "no_subscription") {
      return conflict("Org has no active subscription");
    }
    return badRequestMessage(
      `Cannot downgrade from ${result.currentTier} to ${result.targetTier}: target tier is same or higher`,
    );
  }

  return {
    status: 200 as const,
    body: { success: true, effectiveDate: result.effectiveDate },
  };
});

const downgrade$ = command(async ({ set }, signal: AbortSignal) => {
  if (!optionalEnv("STRIPE_SECRET_KEY")) {
    return providerUnavailable("Billing not configured");
  }

  return await set(
    authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      downgradeAuthed$,
    ),
    signal,
  );
});

export const zeroBillingDowngradeRoutes: readonly RouteEntry[] = [
  {
    route: zeroBillingDowngradeContract.create,
    handler: downgrade$,
  },
];
