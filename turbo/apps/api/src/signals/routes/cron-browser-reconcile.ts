import { cronBrowserReconcileContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { reconcileBrowsers$ } from "../services/browser.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const reconcileBrowsersRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }
    const body = await set(reconcileBrowsers$, signal);
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
