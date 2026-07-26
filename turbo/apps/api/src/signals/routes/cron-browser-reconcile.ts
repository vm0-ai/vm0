import { cronBrowserReconcileContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { dispatchFailedRunCallbacks } from "../services/agent-run-callback.service";
import { drainStaleChatThreadQueues$ } from "../services/chat-thread-queue-drain.service";
import { reconcileZeroBrowsers$ } from "../services/zero-browser.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const reconcileBrowsersRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }
    const body = await set(reconcileZeroBrowsers$, signal);
    signal.throwIfAborted();
    await set(
      drainStaleChatThreadQueues$,
      { dispatchFailedCallbacks: dispatchFailedRunCallbacks },
      signal,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body };
  },
);

export const cronBrowserReconcileRoutes: readonly RouteEntry[] = [
  {
    route: cronBrowserReconcileContract.reconcile,
    handler: reconcileBrowsersRoute$,
  },
];
