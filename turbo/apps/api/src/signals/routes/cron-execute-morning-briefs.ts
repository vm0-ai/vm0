import { cronExecuteMorningBriefsContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { now, nowDate } from "../external/time";
import { executeDueMorningBriefs$ } from "../services/morning-brief-run.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

// Minute tick: claims due morning_brief_schedules rows and runs the
// collect → R2 → default-agent-run pipeline for each claimed member.
const executeMorningBriefsRoute$: RouteEntry["handler"] = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(
      executeDueMorningBriefs$,
      { currentTime: nowDate(), apiStartTime: now() },
      signal,
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        success: true as const,
        executed: result.executed,
        skipped: result.skipped,
      },
    };
  },
);

export const cronExecuteMorningBriefsRoutes: readonly RouteEntry[] = [
  {
    route: cronExecuteMorningBriefsContract.execute,
    handler: executeMorningBriefsRoute$,
  },
];
