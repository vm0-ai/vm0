import { zeroConnectorExternalCodeSessionContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route";
import {
  completeConnectorExternalCodeSession$,
  startConnectorExternalCodeSession$,
} from "../services/connector-external-code.service";

const connectorWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const startConnectorExternalCodeSessionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(zeroConnectorExternalCodeSessionContract.create),
    );
    const body = await get(
      bodyResultOf(zeroConnectorExternalCodeSessionContract.create),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    return await set(
      startConnectorExternalCodeSession$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        type: params.type,
        authMethod: body.data.authMethod,
      },
      signal,
    );
  },
);

const completeConnectorExternalCodeSessionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(zeroConnectorExternalCodeSessionContract.complete),
    );
    const body = await get(
      bodyResultOf(zeroConnectorExternalCodeSessionContract.complete),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    return await set(
      completeConnectorExternalCodeSession$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        type: params.type,
        sessionId: params.sessionId,
        sessionToken: body.data.sessionToken,
        code: body.data.code,
      },
      signal,
    );
  },
);

export const zeroConnectorsExternalCodeRoutes: readonly RouteEntry[] = [
  {
    route: zeroConnectorExternalCodeSessionContract.create,
    handler: authRoute(
      connectorWriteAuth,
      startConnectorExternalCodeSessionInner$,
    ),
  },
  {
    route: zeroConnectorExternalCodeSessionContract.complete,
    handler: authRoute(
      connectorWriteAuth,
      completeConnectorExternalCodeSessionInner$,
    ),
  },
];
