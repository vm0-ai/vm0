import { computed } from "ccstate";
import { zeroCustomConnectorByIdContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { getCustomConnectorResponse } from "../services/zero-custom-connector.service";
import { notFound } from "../../lib/error";
import type { RouteEntry } from "../route";

const getInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroCustomConnectorByIdContract.get));
  const connector = await get(
    getCustomConnectorResponse({
      orgId: auth.orgId,
      userId: auth.userId,
      connectorId: params.id,
    }),
  );
  if (!connector) {
    return notFound("Custom connector not found");
  }
  return { status: 200 as const, body: connector };
});

export const zeroCustomConnectorsGetRoutes: readonly RouteEntry[] = [
  {
    route: zeroCustomConnectorByIdContract.get,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "connector:read",
      },
      getInner$,
    ),
  },
];
