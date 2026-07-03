import { computed } from "ccstate";
import { zeroCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { zeroCustomConnectorList } from "../services/zero-catalog-data.service";
import type { RouteEntry } from "../route-entry";
import { zeroCustomConnectorsCreateRoutes } from "./zero-custom-connectors-create";
import { zeroCustomConnectorsDeleteRoutes } from "./zero-custom-connectors-delete";
import { zeroCustomConnectorsGetRoutes } from "./zero-custom-connectors-get";
import { zeroCustomConnectorsPatchRoutes } from "./zero-custom-connectors-patch";
import { zeroCustomConnectorProposalRoutes } from "./zero-custom-connectors-proposal";
import { zeroCustomConnectorSecretDeleteRoutes } from "./zero-custom-connectors-secret-delete";
import { zeroCustomConnectorsSecretSetRoutes } from "./zero-custom-connectors-secret-set";
import { zeroCustomConnectorsUpdateRoutes } from "./zero-custom-connectors-update";
import { zeroCustomConnectorValuesRoutes } from "./zero-custom-connectors-values";

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
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "connector:read",
      },
      listCustomConnectorsInner$,
    ),
  },
  ...zeroCustomConnectorsCreateRoutes,
  ...zeroCustomConnectorsGetRoutes,
  ...zeroCustomConnectorsDeleteRoutes,
  ...zeroCustomConnectorsPatchRoutes,
  ...zeroCustomConnectorsUpdateRoutes,
  ...zeroCustomConnectorValuesRoutes,
  ...zeroCustomConnectorProposalRoutes,
  ...zeroCustomConnectorSecretDeleteRoutes,
  ...zeroCustomConnectorsSecretSetRoutes,
];
