import { command } from "ccstate";
import { cronRenewGmailWatchesContract } from "@okouai/api-contracts/contracts/cron";

import type { RouteEntry } from "../route-entry";
import {
  type GmailWatchRenewalOptions,
  renewGmailWatches$,
} from "../services/gmail-automation-event.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

function renewGmailWatchesRoute(options: GmailWatchRenewalOptions) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(renewGmailWatches$, options, signal);
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        success: true as const,
        renewed: result.renewed,
        failed: result.failed,
      },
    };
  });
}

function renewGmailWatchesRoutes(
  options: GmailWatchRenewalOptions,
): readonly RouteEntry[] {
  return [
    {
      route: cronRenewGmailWatchesContract.renew,
      handler: renewGmailWatchesRoute(options),
    },
  ];
}

export function cronRenewGmailWatchesRoutesForTest(
  emailAddresses: readonly string[],
): readonly RouteEntry[] {
  return renewGmailWatchesRoutes({ emailAddresses });
}

export const cronRenewGmailWatchesRoutes = renewGmailWatchesRoutes({});
