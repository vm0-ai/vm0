import { command } from "ccstate";
import { cronRenewGoogleFormsWatchesContract } from "@vm0/api-contracts/contracts/cron";

import type { RouteEntry } from "../route-entry";
import { renewGoogleFormsWatches$ } from "../services/google-forms-workflow-event.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const renewGoogleFormsWatchesRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }
    const result = await set(renewGoogleFormsWatches$, signal);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: {
        success: true as const,
        renewed: result.renewed,
        failed: result.failed,
      },
    };
  },
);

export const cronRenewGoogleFormsWatchesRoutes: readonly RouteEntry[] = [
  {
    route: cronRenewGoogleFormsWatchesContract.renew,
    handler: renewGoogleFormsWatchesRoute$,
  },
];
