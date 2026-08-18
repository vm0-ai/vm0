import { cronExecuteWeeklyProductUpdatesContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { nowDate } from "../../lib/time";
import { executeWeeklyProductUpdates$ } from "../services/weekly-product-update.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

// Minute tick: backstops broadcasts the Resend webhook never delivered, then
// advances the fan-out of the oldest ready update by one bounded batch.
const executeWeeklyProductUpdatesRoute$: RouteEntry["handler"] = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(
      executeWeeklyProductUpdates$,
      { currentTime: nowDate() },
      signal,
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        success: true as const,
        claimed: result.claimed,
        delivered: result.delivered,
        skipped: result.skipped,
      },
    };
  },
);

export const cronExecuteWeeklyProductUpdatesRoutes: readonly RouteEntry[] = [
  {
    route: cronExecuteWeeklyProductUpdatesContract.execute,
    handler: executeWeeklyProductUpdatesRoute$,
  },
];
