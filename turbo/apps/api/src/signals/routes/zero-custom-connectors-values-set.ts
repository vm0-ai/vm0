import { command } from "ccstate";
import { zeroCustomConnectorValuesContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { setCustomConnectorValues$ } from "../services/zero-custom-connector.service";
import type { RouteEntry } from "../route-entry";

const setValuesInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroCustomConnectorValuesContract.set));
  const bodyResult = await get(
    bodyResultOf(zeroCustomConnectorValuesContract.set),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const result = await set(
    setCustomConnectorValues$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      connectorId: params.id,
      values: bodyResult.data.values,
      syncLegacySecret: true,
    },
    signal,
  );
  signal.throwIfAborted();
  if ("status" in result) {
    return result;
  }

  return { status: 200 as const, body: result };
});

export const zeroCustomConnectorsValuesSetRoutes: readonly RouteEntry[] = [
  {
    route: zeroCustomConnectorValuesContract.set,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "connector:write",
      },
      setValuesInner$,
    ),
  },
];
