import { command } from "ccstate";
import { zeroCustomConnectorSecretContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { disconnectCustomConnector$ } from "../services/zero-custom-connector.service";
import type { RouteEntry } from "../route-entry";

const deleteSecretInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(zeroCustomConnectorSecretContract.delete));
    signal.throwIfAborted();

    const result = await set(
      disconnectCustomConnector$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        connectorId: params.id,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result) {
      return result;
    }

    return { status: 204 as const, body: undefined };
  },
);

export const zeroCustomConnectorSecretDeleteRoutes: readonly RouteEntry[] = [
  {
    route: zeroCustomConnectorSecretContract.delete,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      deleteSecretInner$,
    ),
  },
];
