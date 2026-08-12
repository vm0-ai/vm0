import { computed } from "ccstate";
import { zeroCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { zeroCustomConnectorList } from "../services/zero-catalog-data.service";
import type { RouteEntry } from "../route-entry";
import { zeroCustomConnectorsCreateRoutes } from "./zero-custom-connectors-create";
import { zeroCustomConnectorsDeleteRoutes } from "./zero-custom-connectors-delete";
import { zeroCustomConnectorsGetRoutes } from "./zero-custom-connectors-get";
import { zeroCustomConnectorsUpdateRoutes } from "./zero-custom-connectors-update";
import { zeroCustomConnectorProposalRoutes } from "./zero-custom-connectors-proposal";
import { zeroCustomConnectorDisconnectRoutes } from "./zero-custom-connectors-disconnect";
import { zeroCustomConnectorOAuth2Routes } from "./zero-custom-connectors-oauth2";
import { zeroCustomConnectorsValuesSetRoutes } from "./zero-custom-connectors-values-set";

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
  ...zeroCustomConnectorsUpdateRoutes,
  ...zeroCustomConnectorProposalRoutes,
  ...zeroCustomConnectorDisconnectRoutes,
  ...zeroCustomConnectorsValuesSetRoutes,
  ...zeroCustomConnectorOAuth2Routes,
];
