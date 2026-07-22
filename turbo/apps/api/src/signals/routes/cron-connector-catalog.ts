import { cronConnectorCatalogContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { db$, type ReadonlyDb } from "../external/db";
import {
  connectorCatalogCompatibilityStatus$,
  reconcileConnectorCatalogCompatibility$,
} from "../services/connector-catalog-compatibility.service";
import {
  connectorCatalogStatus$,
  syncConnectorCatalog$,
} from "../services/connector-catalog-sync.service";
import { loadConnectorCredentialReadiness } from "../services/connector-credential-readiness.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

async function connectorCredentialReadiness(db: ReadonlyDb) {
  return await loadConnectorCredentialReadiness(db);
}

const syncConnectorCatalogRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(syncConnectorCatalog$, signal);
    await set(reconcileConnectorCatalogCompatibility$, signal);
    const status = await set(connectorCatalogStatus$, signal);
    const compatibility = await set(
      connectorCatalogCompatibilityStatus$,
      status.active,
      signal,
    );
    const db = get(db$);
    const credentialStorage = await connectorCredentialReadiness(db);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: {
        outcome: result.outcome,
        ...status,
        filtering: compatibility,
        credentialStorage,
      },
    };
  },
);

const connectorCatalogStatusRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(connectorCatalogStatus$, signal);
    const compatibility = await set(
      connectorCatalogCompatibilityStatus$,
      result.active,
      signal,
    );
    const db = get(db$);
    const credentialStorage = await connectorCredentialReadiness(db);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { ...result, filtering: compatibility, credentialStorage },
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
