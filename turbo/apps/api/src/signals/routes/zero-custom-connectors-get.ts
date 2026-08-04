import { computed } from "ccstate";
import { zeroCustomConnectorByIdContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import {
  getCustomConnectorPermissionBundle,
  getCustomConnectorResponse,
} from "../services/zero-custom-connector.service";
import { notFound } from "../../lib/error";
import type { RouteEntry } from "../route-entry";

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

const getPermissionsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroCustomConnectorByIdContract.permissions));
  const permissions = await get(
    getCustomConnectorPermissionBundle({
      orgId: auth.orgId,
      connectorId: params.id,
    }),
  );
  if (!permissions) {
    return notFound("Custom connector permission bundle not found");
  }
  return { status: 200 as const, body: permissions };
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
  {
    route: zeroCustomConnectorByIdContract.permissions,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "connector:read",
      },
      getPermissionsInner$,
    ),
  },
];
