import { cronExecuteSchedulesContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route";
import { executeDueTriggers$ } from "../services/automations/trigger-poller";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

// The cron tick polls the events-first automation_triggers table; runs carry
// automation_id/trigger_id provenance (#16847).
const executeSchedulesRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(executeDueTriggers$, signal);
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
