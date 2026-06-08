import { zeroConnectorOauthDeviceAuthSessionContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route";
import {
  pollConnectorOauthDeviceAuthSession$,
  startConnectorOauthDeviceAuthSession$,
} from "../services/connector-oauth-device-auth.service";

const connectorWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const startConnectorOauthDeviceAuthSessionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(zeroConnectorOauthDeviceAuthSessionContract.create),
    );
    const body = await get(
      bodyResultOf(zeroConnectorOauthDeviceAuthSessionContract.create),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    return await set(
      startConnectorOauthDeviceAuthSession$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        type: params.type,
        authMethod: body.data.authMethod,
        options: body.data.options,
      },
      signal,
    );
  },
);

const pollConnectorOauthDeviceAuthSessionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(zeroConnectorOauthDeviceAuthSessionContract.poll),
    );
    const body = await get(
      bodyResultOf(zeroConnectorOauthDeviceAuthSessionContract.poll),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    return await set(
      pollConnectorOauthDeviceAuthSession$,
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

export const zeroConnectorsOauthDeviceAuthRoutes: readonly RouteEntry[] = [
  {
    route: zeroConnectorOauthDeviceAuthSessionContract.create,
    handler: authRoute(
      connectorWriteAuth,
      startConnectorOauthDeviceAuthSessionInner$,
    ),
  },
  {
    route: zeroConnectorOauthDeviceAuthSessionContract.poll,
    handler: authRoute(
      connectorWriteAuth,
      pollConnectorOauthDeviceAuthSessionInner$,
    ),
  },
];
