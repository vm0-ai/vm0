import { computed } from "ccstate";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { orgBillingStatus } from "../services/billing-status.service";
import type { RouteEntry } from "../route-entry";

const getBillingStatusInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const body = await get(orgBillingStatus(auth.orgId));
  return { status: 200 as const, body };
});

export const billingStatusRoutes: readonly RouteEntry[] = [
  {
    route: billingStatusContract.get,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "billing:read",
      },
      getBillingStatusInner$,
    ),
  },
];
