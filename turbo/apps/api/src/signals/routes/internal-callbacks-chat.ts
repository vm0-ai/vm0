import { command } from "ccstate";
import { internalCallbacksChatContract } from "@vm0/api-contracts/contracts/internal-callbacks-chat";

import {
  callbackPayload$,
  callbackRoute,
} from "../../lib/callback-route/callback-route";
import type { RouteEntry } from "../route";
import { handleChatInternalCallback$ } from "../services/internal-chat-run-callback.service";

function successResponse(): {
  readonly status: 200;
  readonly body: { readonly success: true };
} {
  return { status: 200, body: { success: true } };
}

function errorResponse(message: string): {
  readonly status: 400;
  readonly body: { readonly error: string };
} {
  return { status: 400, body: { error: message } };
}

const handleChatCallbackRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const result = await set(
      handleChatInternalCallback$,
      get(callbackPayload$),
      signal,
    );
    return result.success ? successResponse() : errorResponse(result.error);
  },
);

export const internalCallbacksChatRoutes: readonly RouteEntry[] = [
  {
    route: internalCallbacksChatContract.post,
    handler: callbackRoute(handleChatCallbackRoute$),
  },
];
