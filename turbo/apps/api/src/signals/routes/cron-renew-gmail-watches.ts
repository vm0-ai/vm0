import { command } from "ccstate";
import { cronRenewGmailWatchesContract } from "@vm0/api-contracts/contracts/cron";

import type { RouteEntry } from "../route";
import { renewGmailWatches$ } from "../services/gmail-event.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const renewGmailWatchesRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(renewGmailWatches$, signal);
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        success: true as const,
        renewed: result.renewed,
        failed: result.failed,
      },
    };
  },
);

export const cronRenewGmailWatchesRoutes: readonly RouteEntry[] = [
  {
    route: cronRenewGmailWatchesContract.renew,
    handler: renewGmailWatchesRoute$,
  },
];
