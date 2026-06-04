import { cronSummarizeMemoryContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route";
import { summarizeMemory$ } from "../services/cron-summarize-memory.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const summarizeMemoryRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const body = await set(summarizeMemory$, signal);
    signal.throwIfAborted();
    return { status: 200 as const, body };
  },
);

export const cronSummarizeMemoryRoutes: readonly RouteEntry[] = [
  {
    route: cronSummarizeMemoryContract.summarize,
    handler: summarizeMemoryRoute$,
  },
];
