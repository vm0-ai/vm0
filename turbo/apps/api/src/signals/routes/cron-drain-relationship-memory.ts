import { cronDrainRelationshipMemoryContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { drainRelationshipSyncJobs$ } from "../services/relationship-memory-gmail.service";
import { advanceGmailRelationshipBackfillJobs$ } from "../services/relationship-memory-gmail-backfill.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const drainRelationshipMemoryRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const backfill = await set(advanceGmailRelationshipBackfillJobs$, signal);
    signal.throwIfAborted();
    const drain = await set(drainRelationshipSyncJobs$, signal);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: {
        ...drain,
        backfill,
      },
    };
  },
);

export const cronDrainRelationshipMemoryRoutes: readonly RouteEntry[] = [
  {
    route: cronDrainRelationshipMemoryContract.drain,
    handler: drainRelationshipMemoryRoute$,
  },
];
