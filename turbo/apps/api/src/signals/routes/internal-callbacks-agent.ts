import { command } from "ccstate";
import { internalCallbacksAgentContract } from "@vm0/api-contracts/contracts/internal-callbacks-agent";

import {
  callbackPayload$,
  callbackRoute,
} from "../../lib/callback-route/callback-route";
import type { RouteEntry } from "../route";
import { handleAgentInternalCallback$ } from "../services/internal-agent-run-callback.service";

const handleAgentCallback$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const callback = get(callbackPayload$);

    await set(handleAgentInternalCallback$, callback, signal);
    signal.throwIfAborted();

    return { status: 200 as const, body: { success: true as const } };
  },
);

export const internalCallbacksAgentRoutes: readonly RouteEntry[] = [
  {
    route: internalCallbacksAgentContract.post,
    handler: callbackRoute(handleAgentCallback$),
  },
];
