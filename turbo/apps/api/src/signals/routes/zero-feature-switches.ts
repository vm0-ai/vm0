import { computed } from "ccstate";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { shadowCompareRoute } from "../context/shadow-compare";
import type { RouteEntry } from "../route";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";

const getFeatureSwitchesInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  const switches = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  return {
    status: 200 as const,
    body: { switches },
  };
});

export const zeroFeatureSwitchesRoutes: readonly RouteEntry[] = [
  {
    route: zeroFeatureSwitchesContract.get,
    handler: shadowCompareRoute({
      route: zeroFeatureSwitchesContract.get,
      handler: authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        getFeatureSwitchesInner$,
      ),
    }),
  },
];
