import { command } from "ccstate";
import { zeroBillingAutoRechargeContract } from "@vm0/api-contracts/contracts/zero-billing";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import {
  shadowCompareRoute,
  type ShadowCompareSource,
} from "../context/shadow-compare";
import { autoRechargeConfig } from "../services/billing.service";
import type { RouteEntry } from "../route";

const MISSING_ORG_RESPONSE = Object.freeze({
  status: 401 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Not authenticated",
      code: "UNAUTHORIZED",
    }),
  }),
});

const getAutoRechargeInner$ = command(async ({ get }): Promise<unknown> => {
  const auth = get(authContext$);
  if (!auth.orgId) {
    return MISSING_ORG_RESPONSE;
  }

  const body = await get(autoRechargeConfig(auth.orgId));
  return {
    status: 200 as const,
    body,
  };
});

export function zeroBillingAutoRechargeRoutes(
  source: ShadowCompareSource = "web",
): readonly RouteEntry[] {
  return [
    {
      route: zeroBillingAutoRechargeContract.get,
      handler: shadowCompareRoute({
        routeName: "zero.billing.auto-recharge.get",
        handler: authRoute({}, getAutoRechargeInner$),
        source,
      }),
    },
  ];
}
