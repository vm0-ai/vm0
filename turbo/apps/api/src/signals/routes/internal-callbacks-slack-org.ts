import { command } from "ccstate";
import { internalCallbacksSlackOrgContract } from "@vm0/api-contracts/contracts/internal-callbacks-slack-org";

import {
  callbackPayload$,
  callbackRoute,
} from "../../lib/callback-route/callback-route";
import type { RouteEntry } from "../route";
import { handleSlackOrgInternalCallback$ } from "../services/internal-slack-org-run-callback.service";

function successResponse(): {
  readonly status: 200;
  readonly body: { readonly success: true };
} {
  return { status: 200, body: { success: true } };
}

function errorResponse(
  status: 400 | 404 | 502,
  message: string,
): {
  readonly status: 400 | 404 | 502;
  readonly body: { readonly error: string };
} {
  return { status, body: { error: message } };
}

const handleSlackOrgCallbackRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const result = await set(
      handleSlackOrgInternalCallback$,
      get(callbackPayload$),
      signal,
    );
    return result.success
      ? successResponse()
      : errorResponse(result.status, result.error);
  },
);

export const internalCallbacksSlackOrgRoutes: readonly RouteEntry[] = [
  {
    route: internalCallbacksSlackOrgContract.post,
    handler: callbackRoute(handleSlackOrgCallbackRoute$),
  },
];
