import { computed } from "ccstate";
import { zeroCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { zeroCustomConnectorList } from "../services/zero-catalog-data.service";
import type { RouteEntry } from "../route";
import { zeroCustomConnectorsCreateRoutes } from "./zero-custom-connectors-create";
import { zeroCustomConnectorsDeleteRoutes } from "./zero-custom-connectors-delete";
import { zeroCustomConnectorSecretDeleteRoutes } from "./zero-custom-connectors-secret-delete";

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
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listCustomConnectorsInner$,
    ),
  },
  ...zeroCustomConnectorsCreateRoutes,
  ...zeroCustomConnectorsDeleteRoutes,
  ...zeroCustomConnectorSecretDeleteRoutes,
];
