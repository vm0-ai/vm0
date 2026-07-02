import { command } from "ccstate";
import { cronRenewGoogleWorkspaceEventSubscriptionsContract } from "@vm0/api-contracts/contracts/cron";

import type { RouteEntry } from "../route-entry";
import { renewGoogleWorkspaceEventSubscriptions$ } from "../services/google-meet-workflow-event.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const renewGoogleWorkspaceEventSubscriptionsRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(renewGoogleWorkspaceEventSubscriptions$, signal);
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        success: true as const,
        renewed: result.renewed,
        repaired: result.repaired,
        failed: result.failed,
      },
    };
  },
);

export const cronRenewGoogleWorkspaceEventSubscriptionsRoutes: readonly RouteEntry[] =
  [
    {
      route: cronRenewGoogleWorkspaceEventSubscriptionsContract.renew,
      handler: renewGoogleWorkspaceEventSubscriptionsRoute$,
    },
  ];
