import { computed } from "ccstate";
import { zeroBillingStatusContract } from "@vm0/api-contracts/contracts/zero-billing";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { shadowCompareRoute } from "../context/shadow-compare";
import { zeroBillingStatus } from "../services/zero-billing-status.service";
import type { RouteEntry } from "../route";

const getBillingStatusInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const body = await get(zeroBillingStatus(auth.orgId));
  return { status: 200 as const, body };
});

export const zeroBillingStatusRoutes: readonly RouteEntry[] = [
  {
    route: zeroBillingStatusContract.get,
    handler: shadowCompareRoute({
      route: zeroBillingStatusContract.get,
      handler: authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        getBillingStatusInner$,
      ),
    }),
  },
];
