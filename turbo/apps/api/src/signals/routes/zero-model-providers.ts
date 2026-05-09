import { computed } from "ccstate";
import { zeroModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-model-providers";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { zeroModelProviders } from "../services/zero-model-provider.service";
import type { RouteEntry } from "../route";

const listModelProvidersInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const result = await get(zeroModelProviders(auth.orgId));
  return { status: 200 as const, body: result };
});

export const zeroModelProvidersRoutes: readonly RouteEntry[] = [
  {
    route: zeroModelProvidersMainContract.list,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listModelProvidersInner$,
    ),
  },
];
