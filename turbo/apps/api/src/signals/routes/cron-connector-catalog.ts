import { cronConnectorCatalogContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import {
  connectorCatalogCompatibilityStatus$,
  reconcileConnectorCatalogCompatibility$,
  type ConnectorCatalogCompatibilityResult,
} from "../services/connector-catalog-compatibility.service";
import {
  connectorCatalogStatus$,
  syncConnectorCatalog$,
  type ConnectorCatalogRawSyncStatus,
} from "../services/connector-catalog-sync.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

function activeSnapshotMatches(
  active: ConnectorCatalogRawSyncStatus["active"],
  snapshot: ConnectorCatalogCompatibilityResult["snapshot"],
): boolean {
  return (
    (active === null && snapshot === null) ||
    (active !== null &&
      snapshot !== null &&
      active.catalogVersion === snapshot.catalogVersion &&
      active.integrityDigest === snapshot.integrityDigest)
  );
}

const syncConnectorCatalogRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(syncConnectorCatalog$, signal);
    while (true) {
      const compatibility = await set(
        reconcileConnectorCatalogCompatibility$,
        signal,
      );
      const status = await set(connectorCatalogStatus$, signal);
      signal.throwIfAborted();
      if (activeSnapshotMatches(status.active, compatibility.snapshot)) {
        return {
          status: 200 as const,
          body: {
            outcome: result.outcome,
            ...status,
            filtering: compatibility.filtering,
          },
        };
      }
    }
  },
);

const connectorCatalogStatusRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    while (true) {
      const result = await set(connectorCatalogStatus$, signal);
      const compatibility = await set(
        connectorCatalogCompatibilityStatus$,
        signal,
      );
      signal.throwIfAborted();
      if (activeSnapshotMatches(result.active, compatibility.snapshot)) {
        return {
          status: 200 as const,
          body: { ...result, filtering: compatibility.filtering },
        };
      }
    }
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
