import { command } from "ccstate";
import { customConnectorByIdContract } from "@okouai/api-contracts/contracts/custom-connectors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import {
  getCustomConnectorResponse,
  updateCustomConnectorDefinition$,
} from "../services/custom-connector.service";
import { notFound } from "../../lib/error";
import type { RouteEntry } from "../route-entry";

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

  const params = get(pathParamsOf(customConnectorByIdContract.update));
  const bodyResult = await get(
    bodyResultOf(customConnectorByIdContract.update),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const result = await set(
    updateCustomConnectorDefinition$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      id: params.id,
      input: bodyResult.data,
    },
    signal,
  );
  signal.throwIfAborted();
  if ("status" in result) {
    return result;
  }

  const connector = await get(
    getCustomConnectorResponse({
      orgId: auth.orgId,
      userId: auth.userId,
      connectorId: result.id,
    }),
  );
  signal.throwIfAborted();
  if (!connector) {
    return notFound("Custom connector not found");
  }
  return { status: 200 as const, body: connector };
});

export const customConnectorsUpdateRoutes: readonly RouteEntry[] = [
  {
    route: customConnectorByIdContract.update,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "connector:write",
      },
      updateInner$,
    ),
  },
];
