import { computed } from "ccstate";
import { zeroUserPreferencesContract } from "@vm0/api-contracts/contracts/zero-user-preferences";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { shadowCompareRoute } from "../context/shadow-compare";
import type { RouteEntry } from "../route";
import { userPreferences } from "../services/zero-user-data.service";

const getUserPreferencesInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  const body = await get(
    userPreferences({ orgId: auth.orgId, userId: auth.userId }),
  );
  return {
    status: 200 as const,
    body,
  };
});

export const zeroUserPreferencesRoutes: readonly RouteEntry[] = [
  {
    route: zeroUserPreferencesContract.get,
    handler: shadowCompareRoute({
      route: zeroUserPreferencesContract.get,
      handler: authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        getUserPreferencesInner$,
      ),
    }),
  },
];
