import { cronProcessUsageEventsContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import { queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { processStaleUsageEvents$ } from "../services/cron-process-usage-events.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const processQuery$ = queryOf(cronProcessUsageEventsContract.process);

const processUsageEventsRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const query = get(processQuery$);
    const processed = await set(processStaleUsageEvents$, query.orgId, signal);
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
