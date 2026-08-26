import { cronOfficialWorkflowCatalogContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import {
  createOfficialWorkflowCatalogSyncCommand,
  syncOfficialWorkflowCatalog$,
} from "../services/official-workflow-catalog-sync.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

function routesForSyncCommand(
  syncCommand: ReturnType<typeof createOfficialWorkflowCatalogSyncCommand>,
): readonly RouteEntry[] {
  const syncOfficialWorkflowCatalogRoute$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      if (!get(hasValidCronSecret$)) {
        return cronUnauthorized();
      }
      return {
        status: 200 as const,
        body: await set(syncCommand, signal),
      };
    },
  );
  return [
    {
      route: cronOfficialWorkflowCatalogContract.sync,
      handler: syncOfficialWorkflowCatalogRoute$,
    },
  ];
}

export function createCronOfficialWorkflowCatalogRoutes(
  candidate: unknown,
): readonly RouteEntry[] {
  return routesForSyncCommand(
    createOfficialWorkflowCatalogSyncCommand(candidate),
  );
}

export const cronOfficialWorkflowCatalogRoutes = routesForSyncCommand(
  syncOfficialWorkflowCatalog$,
);
