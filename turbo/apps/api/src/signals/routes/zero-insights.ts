import { computed } from "ccstate";
import {
  zeroInsightsContract,
  zeroInsightsRangeContract,
} from "@vm0/api-contracts/contracts/zero-insights";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { shadowCompareRoute } from "../context/shadow-compare";
import {
  zeroInsights,
  zeroInsightsRange,
} from "../services/zero-insights.service";
import type { RouteEntry } from "../route";

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

const getInsightsRangeInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const result = await get(
    zeroInsightsRange({ orgId: auth.orgId, userId: auth.userId }),
  );
  return { status: 200 as const, body: result };
});

export const zeroInsightsRoutes: readonly RouteEntry[] = [
  {
    route: zeroInsightsRangeContract.get,
    handler: shadowCompareRoute({
      route: zeroInsightsRangeContract.get,
      handler: authRoute(orgAuth, getInsightsRangeInner$),
    }),
  },
  {
    route: zeroInsightsContract.get,
    handler: authRoute(orgAuth, getInsightsInner$),
  },
];
