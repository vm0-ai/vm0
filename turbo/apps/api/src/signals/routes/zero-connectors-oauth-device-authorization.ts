import { zeroConnectorOauthDeviceAuthorizationSessionContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route";
import {
  pollConnectorOauthDeviceAuthorizationSession$,
  startConnectorOauthDeviceAuthorizationSession$,
} from "../services/connector-oauth-device-authorization.service";

const connectorWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const startConnectorOauthDeviceAuthorizationSessionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(zeroConnectorOauthDeviceAuthorizationSessionContract.create),
    );

    return await set(
      startConnectorOauthDeviceAuthorizationSession$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        type: params.type,
      },
      signal,
    );
  },
);

const pollConnectorOauthDeviceAuthorizationSessionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(zeroConnectorOauthDeviceAuthorizationSessionContract.poll),
    );
    const body = await get(
      bodyResultOf(zeroConnectorOauthDeviceAuthorizationSessionContract.poll),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    return await set(
      pollConnectorOauthDeviceAuthorizationSession$,
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

export const zeroConnectorsOauthDeviceAuthorizationRoutes: readonly RouteEntry[] =
  [
    {
      route: zeroConnectorOauthDeviceAuthorizationSessionContract.create,
      handler: authRoute(
        connectorWriteAuth,
        startConnectorOauthDeviceAuthorizationSessionInner$,
      ),
    },
    {
      route: zeroConnectorOauthDeviceAuthorizationSessionContract.poll,
      handler: authRoute(
        connectorWriteAuth,
        pollConnectorOauthDeviceAuthorizationSessionInner$,
      ),
    },
  ];
