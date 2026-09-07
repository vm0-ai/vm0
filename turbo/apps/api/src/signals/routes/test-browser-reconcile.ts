import { testBrowserReconcileContract } from "@okouai/api-contracts/contracts/test-browser-reconcile";
import { command } from "ccstate";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { reconcileBrowserFixtures$ } from "../services/browser.service";
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
      reconcileBrowserFixtures$,
      bodyResult.data.chat_thread_ids,
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
