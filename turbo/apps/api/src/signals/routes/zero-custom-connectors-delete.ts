import { command } from "ccstate";
import { zeroCustomConnectorByIdContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { deleteCustomConnector$ } from "../services/zero-custom-connector.service";
import { isNotFoundResponse } from "../../lib/error";
import type { RouteEntry } from "../route";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can delete custom connectors",
      code: "FORBIDDEN",
    }),
  }),
});

const deleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }
  const params = get(pathParamsOf(zeroCustomConnectorByIdContract.delete));
  signal.throwIfAborted();

  const result = await set(
    deleteCustomConnector$,
    { orgId: auth.orgId, id: params.id },
    signal,
  );
  signal.throwIfAborted();

  if (isNotFoundResponse(result)) {
    return result;
  }
  return { status: 204 as const, body: undefined };
});

export const zeroCustomConnectorsDeleteRoutes: readonly RouteEntry[] = [
  {
    route: zeroCustomConnectorByIdContract.delete,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      deleteInner$,
    ),
  },
];
