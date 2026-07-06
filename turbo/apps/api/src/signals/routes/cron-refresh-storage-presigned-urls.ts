import { cronRefreshStoragePresignedUrlsContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { refreshStoragePresignedUrls$ } from "../services/cron-refresh-storage-presigned-urls.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const refreshStoragePresignedUrlsRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(refreshStoragePresignedUrls$, signal);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { success: true as const, ...result },
    };
  },
);

export const cronRefreshStoragePresignedUrlsRoutes: readonly RouteEntry[] = [
  {
    route: cronRefreshStoragePresignedUrlsContract.refresh,
    handler: refreshStoragePresignedUrlsRoute$,
  },
];
