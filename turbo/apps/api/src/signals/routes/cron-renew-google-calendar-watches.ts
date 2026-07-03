import { command } from "ccstate";
import { cronRenewGoogleCalendarWatchesContract } from "@vm0/api-contracts/contracts/cron";

import type { RouteEntry } from "../route-entry";
import { renewGoogleCalendarWatches$ } from "../services/google-calendar-workflow-event.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const renewGoogleCalendarWatchesRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(renewGoogleCalendarWatches$, signal);
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

export const cronRenewGoogleCalendarWatchesRoutes: readonly RouteEntry[] = [
  {
    route: cronRenewGoogleCalendarWatchesContract.renew,
    handler: renewGoogleCalendarWatchesRoute$,
  },
];
