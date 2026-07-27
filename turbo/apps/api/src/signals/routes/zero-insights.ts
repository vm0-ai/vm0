import { computed } from "ccstate";
import { zeroInsightsContract } from "@vm0/api-contracts/contracts/zero-insights";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { zeroInsights } from "../services/zero-insights.service";
import type { RouteEntry } from "../route-entry";

const orgAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const getInsightsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(zeroInsightsContract.get));
  const result = await get(
    zeroInsights({
      orgId: auth.orgId,
      userId: auth.userId,
      days: query.days,
    }),
  );
  return { status: 200 as const, body: result };
});

export const zeroInsightsRoutes: readonly RouteEntry[] = [
  {
    route: zeroInsightsContract.get,
    handler: authRoute(orgAuth, getInsightsInner$),
  },
];
