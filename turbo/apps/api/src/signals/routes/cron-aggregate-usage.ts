import { cronAggregateUsageContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route";
import { aggregateUsageDaily$ } from "../services/cron-aggregate-usage.service";
import { cronUnauthorized, hasValidCronSecret } from "./cron-auth";

const aggregateUsageRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!hasValidCronSecret(get)) {
      return cronUnauthorized();
    }

    const body = await set(aggregateUsageDaily$, signal);
    signal.throwIfAborted();
    return { status: 200 as const, body };
  },
);

export const cronAggregateUsageRoutes: readonly RouteEntry[] = [
  {
    route: cronAggregateUsageContract.aggregate,
    handler: aggregateUsageRoute$,
  },
];
