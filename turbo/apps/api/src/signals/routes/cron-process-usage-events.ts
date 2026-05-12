import { cronProcessUsageEventsContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route";
import { processStaleUsageEvents$ } from "../services/cron-process-usage-events.service";
import { cronUnauthorized, hasValidCronSecret } from "./cron-auth";

const processUsageEventsRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!hasValidCronSecret(get)) {
      return cronUnauthorized();
    }

    const processed = await set(processStaleUsageEvents$, signal);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { success: true as const, processed },
    };
  },
);

export const cronProcessUsageEventsRoutes: readonly RouteEntry[] = [
  {
    route: cronProcessUsageEventsContract.process,
    handler: processUsageEventsRoute$,
  },
];
