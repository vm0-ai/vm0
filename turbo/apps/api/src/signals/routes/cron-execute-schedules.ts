import { cronExecuteSchedulesContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route";
import { executeDueSchedules$ } from "../services/zero-schedules.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const executeSchedulesRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(executeDueSchedules$, signal);
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

export const cronExecuteSchedulesRoutes: readonly RouteEntry[] = [
  {
    route: cronExecuteSchedulesContract.execute,
    handler: executeSchedulesRoute$,
  },
];
