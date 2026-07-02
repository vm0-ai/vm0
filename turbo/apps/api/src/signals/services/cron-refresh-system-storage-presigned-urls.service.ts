import { command } from "ccstate";

import { writeDb$ } from "../external/db";
import {
  refreshDueSystemStoragePresignedUrls,
  SYSTEM_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
  SYSTEM_STORAGE_PRESIGNED_URL_REFRESH_LIMIT,
} from "./system-storage-presigned-url-cache.service";

export const refreshSystemStoragePresignedUrls$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const db = set(writeDb$);
    const result = await refreshDueSystemStoragePresignedUrls({
      db,
      get,
      signal,
      limit: SYSTEM_STORAGE_PRESIGNED_URL_REFRESH_LIMIT,
      pruneLimit: SYSTEM_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
    });
    signal.throwIfAborted();
    return result;
  },
);
