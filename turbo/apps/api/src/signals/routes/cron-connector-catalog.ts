import { cronConnectorCatalogContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import {
  connectorCatalogStatus$,
  syncConnectorCatalog$,
} from "../services/connector-catalog-sync.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const syncConnectorCatalogRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(syncConnectorCatalog$, signal);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: result,
    };
  },
);

const connectorCatalogStatusRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(connectorCatalogStatus$, signal);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: result,
    };
  },
);

export const cronConnectorCatalogRoutes: readonly RouteEntry[] = [
  {
    route: cronConnectorCatalogContract.sync,
    handler: syncConnectorCatalogRoute$,
  },
  {
    route: cronConnectorCatalogContract.status,
    handler: connectorCatalogStatusRoute$,
  },
];
