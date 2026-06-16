import { command } from "ccstate";
import { internalCallbacksAgentPhoneContract } from "@vm0/api-contracts/contracts/internal-callbacks-agentphone";

import {
  callbackPayload$,
  callbackRoute,
} from "../../lib/callback-route/callback-route";
import type { RouteEntry } from "../route";
import { handleAgentPhoneInternalCallback$ } from "../services/internal-agentphone-run-callback.service";

function successResponse(): {
  readonly status: 200;
  readonly body: { readonly success: true };
} {
  return { status: 200, body: { success: true } };
}

function errorResponse(
  status: 400 | 502,
  message: string,
): {
  readonly status: 400 | 502;
  readonly body: { readonly error: string };
} {
  return { status, body: { error: message } };
}

const handleAgentPhoneCallbackRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const result = await set(
      handleAgentPhoneInternalCallback$,
      get(callbackPayload$),
      signal,
    );
    return result.success
      ? successResponse()
      : errorResponse(result.status, result.error);
  },
);

export const internalCallbacksAgentPhoneRoutes: readonly RouteEntry[] = [
  {
    route: internalCallbacksAgentPhoneContract.post,
    handler: callbackRoute(handleAgentPhoneCallbackRoute$),
  },
];
