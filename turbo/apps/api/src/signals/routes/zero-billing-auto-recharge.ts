import { command, computed } from "ccstate";
import { zeroBillingAutoRechargeContract } from "@vm0/api-contracts/contracts/zero-billing";

import { badRequestMessage } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import {
  autoRechargeConfig,
  updateAutoRechargeConfig$,
} from "../services/billing.service";
import type { RouteEntry } from "../route";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can update auto-recharge settings",
      code: "FORBIDDEN",
    }),
  }),
});

const getAutoRechargeInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  const body = await get(autoRechargeConfig(auth.orgId));
  return {
    status: 200 as const,
    body,
  };
});

const updateAutoRechargeInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }

    const bodyResult = await get(
      bodyResultOf(zeroBillingAutoRechargeContract.update),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await set(
      updateAutoRechargeConfig$,
      {
        orgId: auth.orgId,
        enabled: bodyResult.data.enabled,
        threshold: bodyResult.data.threshold,
        amount: bodyResult.data.amount,
      },
      signal,
    );
    signal.throwIfAborted();

    if (!result.ok) {
      return badRequestMessage(result.error);
    }

    return { status: 200 as const, body: result.data };
  },
);

export const zeroBillingAutoRechargeRoutes: readonly RouteEntry[] = [
  {
    route: zeroBillingAutoRechargeContract.get,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getAutoRechargeInner$,
    ),
  },
  {
    route: zeroBillingAutoRechargeContract.update,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      updateAutoRechargeInner$,
    ),
  },
];
