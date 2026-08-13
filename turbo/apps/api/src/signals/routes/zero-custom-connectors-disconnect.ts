import { command } from "ccstate";
import { zeroCustomConnectorConnectionContract } from "@okouai/api-contracts/contracts/zero-custom-connectors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { disconnectCustomConnector$ } from "../services/zero-custom-connector.service";
import type { RouteEntry } from "../route-entry";

const disconnectInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(
    pathParamsOf(zeroCustomConnectorConnectionContract.disconnect),
  );
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
});

const disconnectHandler$ = authRoute(
  { requireOrganization: true, missingOrganizationStatus: 401 },
  disconnectInner$,
);

export const zeroCustomConnectorDisconnectRoutes: readonly RouteEntry[] = [
  {
    route: zeroCustomConnectorConnectionContract.disconnect,
    handler: disconnectHandler$,
  },
];
