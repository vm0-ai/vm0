import { command } from "ccstate";
import {
  bb0DeviceConfirmContract,
  deviceTokenContract,
} from "@vm0/api-contracts/contracts/device-token";

import { badRequestMessage, notFound } from "../../lib/error";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import {
  confirmBb0Device$,
  createBb0DeviceCode$,
  pollBb0Device$,
} from "../services/device-token.service";
import type { RouteEntry } from "../route";

const createBody$ = bodyResultOf(deviceTokenContract.create);
const pollBody$ = bodyResultOf(deviceTokenContract.poll);
const confirmBody$ = bodyResultOf(bb0DeviceConfirmContract.confirm);

const createDeviceToken$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(createBody$);
    signal.throwIfAborted();
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
  },
);

const pollDeviceToken$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(pollBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const result = await set(
    pollBb0Device$,
    {
      deviceCode: body.data.device_code,
      pollToken: body.data.poll_token,
    },
    signal,
  );

  if (result.status === "pending") {
    return {
      status: 202 as const,
      body: result,
    };
  }

  if (result.status === "approved") {
    return {
      status: 200 as const,
      body: result,
    };
  }

  if (result.status === "expired") {
    return {
      status: 410 as const,
      body: result,
    };
  }

  return {
    status: 404 as const,
    body: result,
  };
});

const confirmBb0DeviceInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(confirmBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const auth = get(authContext$);
    if (!auth.orgId) {
      return badRequestMessage("No active organization selected");
    }

    const result = await set(
      confirmBb0Device$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        deviceCode: body.data.device_code,
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

const confirmBb0DeviceRoute$ = authRoute(
  { accept: ["session"] },
  confirmBb0DeviceInner$,
);

export const deviceTokenRoutes: readonly RouteEntry[] = [
  { route: deviceTokenContract.create, handler: createDeviceToken$ },
  { route: deviceTokenContract.poll, handler: pollDeviceToken$ },
  { route: bb0DeviceConfirmContract.confirm, handler: confirmBb0DeviceRoute$ },
];
