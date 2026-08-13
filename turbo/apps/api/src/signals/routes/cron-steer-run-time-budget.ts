import { cronSteerRunTimeBudgetContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { steerRunsNearTimeBudget$ } from "../services/cron-steer-run-time-budget.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const steerRunTimeBudgetRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const body = await set(steerRunsNearTimeBudget$, signal);
    signal.throwIfAborted();
    return { status: 200 as const, body };
  },
);

export const cronSteerRunTimeBudgetRoutes: readonly RouteEntry[] = [
  {
    route: cronSteerRunTimeBudgetContract.steer,
    handler: steerRunTimeBudgetRoute$,
  },
];
