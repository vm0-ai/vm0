import { computed } from "ccstate";
import { zeroCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { shadowCompareRoute } from "../context/shadow-compare";
import { zeroCustomConnectorList } from "../services/zero-catalog-data.service";
import type { RouteEntry } from "../route";

const listCustomConnectorsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const connectors = await get(
    zeroCustomConnectorList({ orgId: auth.orgId, userId: auth.userId }),
  );
  return { status: 200 as const, body: { connectors: [...connectors] } };
});

export const zeroCustomConnectorsRoutes: readonly RouteEntry[] = [
  {
    route: zeroCustomConnectorsContract.list,
    handler: shadowCompareRoute({
      route: zeroCustomConnectorsContract.list,
      handler: authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        listCustomConnectorsInner$,
      ),
    }),
  },
];
