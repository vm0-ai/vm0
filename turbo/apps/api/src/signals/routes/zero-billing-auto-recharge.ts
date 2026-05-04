import { computed } from "ccstate";
import { zeroBillingAutoRechargeContract } from "@vm0/api-contracts/contracts/zero-billing";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { shadowCompareRoute } from "../context/shadow-compare";
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

export const zeroBillingAutoRechargeRoutes: readonly RouteEntry[] = [
  {
    route: zeroBillingAutoRechargeContract.get,
    handler: shadowCompareRoute({
      route: zeroBillingAutoRechargeContract.get,
      handler: authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        getAutoRechargeInner$,
      ),
    }),
  },
];
