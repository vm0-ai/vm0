import { cronTelegramCleanupContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route";
import { cleanupTelegramMessages$ } from "../services/cron-telegram-cleanup.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const telegramCleanupRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const deleted = await set(cleanupTelegramMessages$, signal);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { deleted },
    };
  },
);

export const cronTelegramCleanupRoutes: readonly RouteEntry[] = [
  {
    route: cronTelegramCleanupContract.cleanup,
    handler: telegramCleanupRoute$,
  },
];
