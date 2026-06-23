import { command } from "ccstate";
import { zeroCustomConnectorValuesContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import {
  deleteCustomConnectorValues$,
  setCustomConnectorValues$,
} from "../services/zero-custom-connector.service";
import type { RouteEntry } from "../route";

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
    },
    signal,
  );
  signal.throwIfAborted();
  if ("status" in result) {
    return result;
  }
  return { status: 200 as const, body: result };
});

const deleteValuesInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(zeroCustomConnectorValuesContract.delete));
    signal.throwIfAborted();

    const result = await set(
      deleteCustomConnectorValues$,
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

export const zeroCustomConnectorValuesRoutes: readonly RouteEntry[] = [
  {
    route: zeroCustomConnectorValuesContract.set,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      setValuesInner$,
    ),
  },
  {
    route: zeroCustomConnectorValuesContract.delete,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      deleteValuesInner$,
    ),
  },
];
