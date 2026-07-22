import { cronConnectorOauthStateCleanupContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { cleanupConnectorOauthStates$ } from "../services/cron-connector-oauth-state-cleanup.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const connectorOauthStateCleanupRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const deleted = await set(cleanupConnectorOauthStates$, signal);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { deleted },
    };
  },
);

export const cronConnectorOauthStateCleanupRoutes: readonly RouteEntry[] = [
  {
    route: cronConnectorOauthStateCleanupContract.cleanup,
    handler: connectorOauthStateCleanupRoute$,
  },
];
