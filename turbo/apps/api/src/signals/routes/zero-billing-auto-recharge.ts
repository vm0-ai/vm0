import { computed } from "ccstate";
import { zeroBillingAutoRechargeContract } from "@vm0/api-contracts/contracts/zero-billing";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import {
  shadowCompareRoute,
  type ShadowCompareSource,
} from "../context/shadow-compare";
import { autoRechargeConfig } from "../services/billing.service";
import type { RouteEntry } from "../route";

const getAutoRechargeInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
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
        handler: authRoute(
          { requireOrganization: true, missingOrganizationStatus: 401 },
          getAutoRechargeInner$,
        ),
        source,
      }),
    },
  ];
}
