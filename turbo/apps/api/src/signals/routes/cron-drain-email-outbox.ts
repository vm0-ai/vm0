import { cronDrainEmailOutboxContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route";
import {
  cleanupExpiredEmailOutbox$,
  drainEmailOutboxBatch$,
} from "../services/zero-email-common.service";
import { cronUnauthorized, hasValidCronSecret } from "./cron-auth";

const drainEmailOutboxRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!hasValidCronSecret(get)) {
      return cronUnauthorized();
    }

    const drained = await set(drainEmailOutboxBatch$, signal);
    signal.throwIfAborted();
    const cleaned = await set(cleanupExpiredEmailOutbox$, signal);
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: { success: true as const, drained, cleaned },
    };
  },
);

export const cronDrainEmailOutboxRoutes: readonly RouteEntry[] = [
  {
    route: cronDrainEmailOutboxContract.drain,
    handler: drainEmailOutboxRoute$,
  },
];
