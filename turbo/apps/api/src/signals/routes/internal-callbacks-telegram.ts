import { command } from "ccstate";
import { internalCallbacksTelegramContract } from "@vm0/api-contracts/contracts/internal-callbacks-telegram";

import {
  callbackPayload$,
  callbackRoute,
} from "../../lib/callback-route/callback-route";
import type { RouteEntry } from "../route";
import { handleTelegramInternalCallback$ } from "../services/internal-telegram-run-callback.service";

function successResponse(): {
  readonly status: 200;
  readonly body: { readonly success: true };
} {
  return { status: 200, body: { success: true } };
}

function errorResponse(
  status: 400 | 500 | 502,
  message: string,
): {
  readonly status: 400 | 500 | 502;
  readonly body: { readonly error: string };
} {
  return { status, body: { error: message } };
}

const handleTelegramCallbackRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const result = await set(
      handleTelegramInternalCallback$,
      get(callbackPayload$),
      signal,
    );
    return result.success
      ? successResponse()
      : errorResponse(result.status, result.error);
  },
);

export const internalCallbacksTelegramRoutes: readonly RouteEntry[] = [
  {
    route: internalCallbacksTelegramContract.post,
    handler: callbackRoute(handleTelegramCallbackRoute$),
  },
];
