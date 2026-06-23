import { command } from "ccstate";
import { zeroCustomConnectorByIdContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import {
  serialiseCustomConnector,
  updateCustomConnectorDefinition$,
} from "../services/zero-custom-connector.service";
import type { RouteEntry } from "../route";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can update custom connectors",
      code: "FORBIDDEN",
    }),
  }),
});

const updateInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }

  const params = get(pathParamsOf(zeroCustomConnectorByIdContract.update));
  const bodyResult = await get(
    bodyResultOf(zeroCustomConnectorByIdContract.update),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    updateCustomConnectorDefinition$,
    {
      orgId: auth.orgId,
      id: params.id,
      input: bodyResult.data,
    },
    signal,
  );
  signal.throwIfAborted();
  if ("status" in result) {
    return result;
  }
  return {
    status: 200 as const,
    body: serialiseCustomConnector({ row: result, valueMarkers: [] }),
  };
});

export const zeroCustomConnectorsUpdateRoutes: readonly RouteEntry[] = [
  {
    route: zeroCustomConnectorByIdContract.update,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      updateInner$,
    ),
  },
];
