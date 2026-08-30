import { computed } from "ccstate";
import { customConnectorByIdContract } from "@okouai/api-contracts/contracts/custom-connectors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import {
  getCustomConnectorPermissionBundle,
  getCustomConnectorResponse,
} from "../services/custom-connector.service";
import { notFound } from "../../lib/error";
import type { RouteEntry } from "../route-entry";

const getInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(customConnectorByIdContract.get));
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
  const params = get(pathParamsOf(customConnectorByIdContract.permissions));
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

export const customConnectorsGetRoutes: readonly RouteEntry[] = [
  {
    route: customConnectorByIdContract.get,
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
    route: customConnectorByIdContract.permissions,
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
