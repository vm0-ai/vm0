import { cronConnectorCatalogContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { db$ } from "../external/db";
import { reconcileConnectorCatalogCompatibility$ } from "../services/connector-catalog-compatibility.service";
import { connectorCatalogDiagnostics$ } from "../services/connector-catalog-diagnostics.service";
import {
  readConnectorCatalogRuntimeProjectionReadiness,
  reconcileConnectorCatalogRuntimeProjection$,
} from "../services/connector-catalog-runtime-projection.service";
import { syncConnectorCatalog$ } from "../services/connector-catalog-sync.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const syncConnectorCatalogRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(syncConnectorCatalog$, signal);
    await set(reconcileConnectorCatalogCompatibility$, signal);
    await set(reconcileConnectorCatalogRuntimeProjection$, signal);
    const diagnostics = await set(connectorCatalogDiagnostics$, signal);
    const runtimeProjection =
      await readConnectorCatalogRuntimeProjectionReadiness({
        db: get(db$),
        active: diagnostics.active,
        capabilityDigest: diagnostics.filtering.capabilityDigest,
      });
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: {
        outcome: result.outcome,
        ...diagnostics,
        runtimeProjection,
      },
    };
  },
);

export const cronConnectorCatalogRoutes: readonly RouteEntry[] = [
  {
    route: cronConnectorCatalogContract.sync,
    handler: syncConnectorCatalogRoute$,
  },
];
