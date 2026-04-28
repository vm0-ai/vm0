import { command } from "ccstate";
import {
  bb0DeviceBindContract,
  deviceTokenContract,
} from "@vm0/api-contracts/contracts/device-token";

import { badRequestMessage, notFound } from "../../lib/error";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import {
  bindBb0Device$,
  createBb0DeviceCode$,
} from "../services/device-token.service";
import type { RouteEntry } from "../route";

const createBody$ = bodyResultOf(deviceTokenContract.create);
const bindBody$ = bodyResultOf(bb0DeviceBindContract.bind);

const createDeviceToken$ = command(async ({ set }, signal: AbortSignal) => {
  const body = await set(createBody$, signal);
  if (!body.ok) {
    return body.response;
  }

  const result = await set(
    createBb0DeviceCode$,
    body.data.ble_session_nonce,
    signal,
  );

  return {
    status: 200 as const,
    body: result,
  };
});

const bindBb0DeviceInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await set(bindBody$, signal);
    if (!body.ok) {
      return body.response;
    }

    const auth = get(authContext$);
    if (!auth.orgId) {
      return badRequestMessage("No active organization selected");
    }

    const result = await set(
      bindBb0Device$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        deviceCode: body.data.device_code,
        bleSessionNonce: body.data.ble_session_nonce,
      },
      signal,
    );

    if (!result.ok) {
      if (result.reason === "missing-default-agent") {
        return badRequestMessage("No default agent configured");
      }
      return notFound("Device code not found or expired");
    }

    return {
      status: 200 as const,
      body: result.data,
    };
  },
);

const bindBb0DeviceRoute$ = authRoute(
  { accept: ["session"] },
  bindBb0DeviceInner$,
);

export const deviceTokenRoutes: readonly RouteEntry[] = [
  { route: deviceTokenContract.create, handler: createDeviceToken$ },
  { route: bb0DeviceBindContract.bind, handler: bindBb0DeviceRoute$ },
];
