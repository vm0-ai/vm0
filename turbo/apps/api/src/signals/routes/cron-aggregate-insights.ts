import { cronAggregateInsightsContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route";
import { aggregateInsights$ } from "../services/cron-aggregate-insights.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const aggregateInsightsRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const body = await set(aggregateInsights$, signal);
    signal.throwIfAborted();
    return { status: 200 as const, body };
  },
);

export const cronAggregateInsightsRoutes: readonly RouteEntry[] = [
  {
    route: cronAggregateInsightsContract.aggregate,
    handler: aggregateInsightsRoute$,
  },
];
