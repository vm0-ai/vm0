import { command } from "ccstate";
import { zeroBillingRestoreContract } from "@vm0/api-contracts/contracts/zero-billing";

import { optionalEnv } from "../../lib/env";
import { conflict, providerUnavailable } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { restoreSubscription$ } from "../services/zero-billing-restore.service";
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

const restoreAuthed$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }
  signal.throwIfAborted();

  const bodyResult = await get(bodyResultOf(zeroBillingRestoreContract.create));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(restoreSubscription$, { orgId: auth.orgId }, signal);
  signal.throwIfAborted();

  if (!result.ok) {
    if (result.reason === "no_subscription") {
      return conflict("Org has no active subscription");
    }
    return conflict("Subscription is not scheduled for cancellation");
  }

  return {
    status: 200 as const,
    body: { success: true },
  };
});

const restore$ = command(async ({ set }, signal: AbortSignal) => {
  if (!optionalEnv("STRIPE_SECRET_KEY")) {
    return providerUnavailable("Billing not configured");
  }

  return await set(
    authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      restoreAuthed$,
    ),
    signal,
  );
});

export const zeroBillingRestoreRoutes: readonly RouteEntry[] = [
  {
    route: zeroBillingRestoreContract.create,
    handler: restore$,
  },
];
