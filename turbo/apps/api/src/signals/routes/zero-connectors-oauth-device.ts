import { zeroConnectorOauthDeviceSessionContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route";
import {
  pollConnectorOauthDeviceSession$,
  startConnectorOauthDeviceSession$,
} from "../services/connector-oauth-device-authorization.service";

const connectorWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const startConnectorOauthDeviceSessionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(zeroConnectorOauthDeviceSessionContract.create),
    );

    return await set(
      startConnectorOauthDeviceSession$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        type: params.type,
      },
      signal,
    );
  },
);

const pollConnectorOauthDeviceSessionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(zeroConnectorOauthDeviceSessionContract.poll),
    );
    const body = await get(
      bodyResultOf(zeroConnectorOauthDeviceSessionContract.poll),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    return await set(
      pollConnectorOauthDeviceSession$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        type: params.type,
        sessionId: params.sessionId,
        sessionToken: body.data.sessionToken,
      },
      signal,
    );
  },
);

export const zeroConnectorsOauthDeviceRoutes: readonly RouteEntry[] = [
  {
    route: zeroConnectorOauthDeviceSessionContract.create,
    handler: authRoute(
      connectorWriteAuth,
      startConnectorOauthDeviceSessionInner$,
    ),
  },
  {
    route: zeroConnectorOauthDeviceSessionContract.poll,
    handler: authRoute(
      connectorWriteAuth,
      pollConnectorOauthDeviceSessionInner$,
    ),
  },
];
