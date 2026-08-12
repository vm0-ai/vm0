import { testBrowserReconcileContract } from "@vm0/api-contracts/contracts/test-browser-reconcile";
import { command } from "ccstate";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { dispatchFailedRunCallbacks } from "../services/agent-run-callback.service";
import { drainStaleChatThreadQueues$ } from "../services/chat-thread-queue-drain.service";
import { reconcileZeroBrowserFixtures$ } from "../services/zero-browser.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const reconcileBody$ = bodyResultOf(testBrowserReconcileContract.reconcile);

const reconcileBrowserFixturesRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(reconcileBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const body = await set(
      reconcileZeroBrowserFixtures$,
      bodyResult.data.chat_thread_ids,
      signal,
    );
    signal.throwIfAborted();
    await set(
      drainStaleChatThreadQueues$,
      {
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
        chatThreadIds: bodyResult.data.chat_thread_ids,
      },
      signal,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body };
  },
);

export const testBrowserReconcileRoutes: readonly RouteEntry[] = [
  {
    route: testBrowserReconcileContract.reconcile,
    handler: reconcileBrowserFixturesRoute$,
  },
];
