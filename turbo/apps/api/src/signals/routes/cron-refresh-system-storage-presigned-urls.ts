import { cronRefreshSystemStoragePresignedUrlsContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { refreshSystemStoragePresignedUrls$ } from "../services/cron-refresh-system-storage-presigned-urls.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const refreshSystemStoragePresignedUrlsRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(refreshSystemStoragePresignedUrls$, signal);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { success: true as const, ...result },
    };
  },
);

export const cronRefreshSystemStoragePresignedUrlsRoutes: readonly RouteEntry[] =
  [
    {
      route: cronRefreshSystemStoragePresignedUrlsContract.refresh,
      handler: refreshSystemStoragePresignedUrlsRoute$,
    },
  ];
