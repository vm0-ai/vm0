import { cronStorageArchiveSizeBackfillContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import {
  backfillStorageArchiveSizes$,
  storageArchiveSizeBackfillStatus$,
} from "../services/cron-backfill-storage-archive-sizes.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const backfillStorageArchiveSizesRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(backfillStorageArchiveSizes$, signal);
    signal.throwIfAborted();
    return { status: 200 as const, body: result };
  },
);

const storageArchiveSizeBackfillStatusRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(storageArchiveSizeBackfillStatus$, signal);
    signal.throwIfAborted();
    return { status: 200 as const, body: result };
  },
);

export const cronStorageArchiveSizeBackfillRoutes: readonly RouteEntry[] = [
  {
    route: cronStorageArchiveSizeBackfillContract.backfill,
    handler: backfillStorageArchiveSizesRoute$,
  },
  {
    route: cronStorageArchiveSizeBackfillContract.status,
    handler: storageArchiveSizeBackfillStatusRoute$,
  },
];
