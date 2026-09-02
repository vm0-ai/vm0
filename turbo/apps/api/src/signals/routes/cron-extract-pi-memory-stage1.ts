import { cronExtractPiMemoryStage1Contract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import { nowDate } from "../../lib/time";
import type { RouteEntry } from "../route-entry";
import { executePiMemoryStage1Work$ } from "../services/pi-memory-stage1-worker.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const extractPiMemoryStage1Route$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }
    const result = await set(
      executePiMemoryStage1Work$,
      { scope: undefined, currentTime: nowDate() },
      signal,
    );
    return {
      status: 200 as const,
      body: { success: true as const, ...result },
    };
  },
);

export const cronExtractPiMemoryStage1Routes: readonly RouteEntry[] = [
  {
    route: cronExtractPiMemoryStage1Contract.extract,
    handler: extractPiMemoryStage1Route$,
  },
];
