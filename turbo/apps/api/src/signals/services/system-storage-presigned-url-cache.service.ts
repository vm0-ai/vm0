import { createHash } from "node:crypto";

import { systemStoragePresignedUrlCache } from "@vm0/db/schema/system-storage-presigned-url-cache";
import type { Computed } from "ccstate";
import { and, asc, gte, inArray, lte, sql } from "drizzle-orm";

import type { Db } from "../external/db";
import { generatePresignedGetUrl } from "../external/s3";
import { nowDate } from "../external/time";

type ComputedGetter = <T>(computedValue: Computed<T>) => T;

export const SYSTEM_STORAGE_PRESIGNED_URL_TTL_SECONDS = 2 * 60 * 60;
const SYSTEM_STORAGE_PRESIGNED_URL_HARD_SAFETY_WINDOW_SECONDS = 15 * 60;
const SYSTEM_STORAGE_PRESIGNED_URL_REFRESH_BASE_SECONDS = 20 * 60;
const SYSTEM_STORAGE_PRESIGNED_URL_REFRESH_JITTER_SECONDS = 30 * 60;
const SYSTEM_STORAGE_PRESIGNED_URL_TOUCH_INTERVAL_SECONDS = 30 * 60;
const SYSTEM_STORAGE_PRESIGNED_URL_ACTIVE_WINDOW_SECONDS = 24 * 60 * 60;
const SYSTEM_STORAGE_PRESIGNED_URL_CACHE_POLICY = "system-storage-url-v1";
export const SYSTEM_STORAGE_PRESIGNED_URL_REFRESH_LIMIT = 3;
export const SYSTEM_STORAGE_PRESIGNED_URL_PRUNE_LIMIT = 100;

export type SystemStoragePresignedUrlCacheStatus =
  | "hit"
  | "stale_reuse"
  | "miss"
  | "sync_refresh";

export interface SystemStoragePresignedUrlRequest {
  readonly bucket: string;
  readonly objectKey: string;
  readonly storageVersionId: string;
  readonly publicEndpoint: boolean;
}

interface SystemStoragePresignedUrlResult {
  readonly cacheKey: string;
  readonly url: string;
  readonly status: SystemStoragePresignedUrlCacheStatus;
}

interface CacheRowValue {
  readonly cacheKey: string;
  readonly bucket: string;
  readonly objectKey: string;
  readonly storageVersionId: string;
  readonly publicEndpoint: boolean;
  readonly ttlSeconds: number;
  readonly presignedUrl: string;
  readonly expiresAt: Date;
  readonly refreshAfter: Date;
  readonly lastRequestedAt: Date;
  readonly updatedAt: Date;
}

export function systemStoragePresignedUrlCacheKey(
  request: SystemStoragePresignedUrlRequest,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        SYSTEM_STORAGE_PRESIGNED_URL_CACHE_POLICY,
        request.bucket,
        request.objectKey,
        request.storageVersionId,
        request.publicEndpoint ? "public" : "private",
        SYSTEM_STORAGE_PRESIGNED_URL_TTL_SECONDS,
      ]),
    )
    .digest("hex");
}

function expirationFromIssuedAt(issuedAt: Date, ttlSeconds: number): Date {
  return new Date(issuedAt.getTime() + ttlSeconds * 1000);
}

function refreshAfterForCacheKey(cacheKey: string, expiresAt: Date): Date {
  const hashPrefix = createHash("sha256")
    .update(cacheKey)
    .digest("hex")
    .slice(0, 8);
  const jitter =
    Number.parseInt(hashPrefix, 16) %
    SYSTEM_STORAGE_PRESIGNED_URL_REFRESH_JITTER_SECONDS;
  const refreshOffsetSeconds =
    SYSTEM_STORAGE_PRESIGNED_URL_REFRESH_BASE_SECONDS + jitter;
  return new Date(expiresAt.getTime() - refreshOffsetSeconds * 1000);
}

function hardSafetyCutoff(issuedAt: Date): Date {
  return new Date(
    issuedAt.getTime() +
      SYSTEM_STORAGE_PRESIGNED_URL_HARD_SAFETY_WINDOW_SECONDS * 1000,
  );
}

function touchCutoff(issuedAt: Date): Date {
  return new Date(
    issuedAt.getTime() -
      SYSTEM_STORAGE_PRESIGNED_URL_TOUCH_INTERVAL_SECONDS * 1000,
  );
}

function activeCutoff(issuedAt: Date): Date {
  return new Date(
    issuedAt.getTime() -
      SYSTEM_STORAGE_PRESIGNED_URL_ACTIVE_WINDOW_SECONDS * 1000,
  );
}

async function signCacheValue(args: {
  readonly get: ComputedGetter;
  readonly request: SystemStoragePresignedUrlRequest;
  readonly cacheKey: string;
  readonly ttlSeconds: number;
  readonly issuedAt: Date;
  readonly lastRequestedAt: Date;
}): Promise<CacheRowValue> {
  const presignedUrl = await args.get(
    generatePresignedGetUrl(
      args.request.bucket,
      args.request.objectKey,
      args.ttlSeconds,
      undefined,
      args.request.publicEndpoint,
    ),
  );
  const expiresAt = expirationFromIssuedAt(args.issuedAt, args.ttlSeconds);
  return {
    cacheKey: args.cacheKey,
    bucket: args.request.bucket,
    objectKey: args.request.objectKey,
    storageVersionId: args.request.storageVersionId,
    publicEndpoint: args.request.publicEndpoint,
    ttlSeconds: args.ttlSeconds,
    presignedUrl,
    expiresAt,
    refreshAfter: refreshAfterForCacheKey(args.cacheKey, expiresAt),
    lastRequestedAt: args.lastRequestedAt,
    updatedAt: args.issuedAt,
  };
}

async function upsertCacheValues(
  db: Db,
  values: readonly CacheRowValue[],
  options: { readonly updateLastRequestedAt: boolean },
): Promise<void> {
  if (values.length === 0) {
    return;
  }
  const set = {
    bucket: sql`excluded.bucket`,
    objectKey: sql`excluded.object_key`,
    storageVersionId: sql`excluded.storage_version_id`,
    publicEndpoint: sql`excluded.public_endpoint`,
    ttlSeconds: sql`excluded.ttl_seconds`,
    presignedUrl: sql`excluded.presigned_url`,
    expiresAt: sql`excluded.expires_at`,
    refreshAfter: sql`excluded.refresh_after`,
    ...(options.updateLastRequestedAt
      ? { lastRequestedAt: sql`excluded.last_requested_at` }
      : {}),
    updatedAt: sql`excluded.updated_at`,
  };
  await db
    .insert(systemStoragePresignedUrlCache)
    .values(
      values.map((value) => {
        return {
          cacheKey: value.cacheKey,
          bucket: value.bucket,
          objectKey: value.objectKey,
          storageVersionId: value.storageVersionId,
          publicEndpoint: value.publicEndpoint,
          ttlSeconds: value.ttlSeconds,
          presignedUrl: value.presignedUrl,
          expiresAt: value.expiresAt,
          refreshAfter: value.refreshAfter,
          lastRequestedAt: value.lastRequestedAt,
          updatedAt: value.updatedAt,
        };
      }),
    )
    .onConflictDoUpdate({
      target: systemStoragePresignedUrlCache.cacheKey,
      set,
    });
}

async function touchRecentlyUsedCacheRows(
  db: Db,
  cacheKeys: readonly string[],
  issuedAt: Date,
): Promise<void> {
  if (cacheKeys.length === 0) {
    return;
  }
  await db
    .update(systemStoragePresignedUrlCache)
    .set({ lastRequestedAt: issuedAt })
    .where(
      and(
        inArray(systemStoragePresignedUrlCache.cacheKey, cacheKeys),
        lte(
          systemStoragePresignedUrlCache.lastRequestedAt,
          touchCutoff(issuedAt),
        ),
      ),
    );
}

async function pruneInactiveExpiredCacheRows(
  db: Db,
  issuedAt: Date,
  limit: number,
  signal?: AbortSignal,
): Promise<number> {
  const inactiveCutoff = activeCutoff(issuedAt);
  const rows = await db
    .select({ cacheKey: systemStoragePresignedUrlCache.cacheKey })
    .from(systemStoragePresignedUrlCache)
    .where(
      and(
        lte(systemStoragePresignedUrlCache.expiresAt, issuedAt),
        lte(systemStoragePresignedUrlCache.lastRequestedAt, inactiveCutoff),
      ),
    )
    .orderBy(
      asc(systemStoragePresignedUrlCache.lastRequestedAt),
      asc(systemStoragePresignedUrlCache.expiresAt),
    )
    .limit(limit);
  signal?.throwIfAborted();

  const cacheKeys = rows.map((row) => {
    return row.cacheKey;
  });
  if (cacheKeys.length === 0) {
    return 0;
  }

  const deletedRows = await db
    .delete(systemStoragePresignedUrlCache)
    .where(
      and(
        inArray(systemStoragePresignedUrlCache.cacheKey, cacheKeys),
        lte(systemStoragePresignedUrlCache.expiresAt, issuedAt),
        lte(systemStoragePresignedUrlCache.lastRequestedAt, inactiveCutoff),
      ),
    )
    .returning({ cacheKey: systemStoragePresignedUrlCache.cacheKey });
  signal?.throwIfAborted();
  return deletedRows.length;
}

export async function resolveSystemStoragePresignedUrls(args: {
  readonly db: Db;
  readonly get: ComputedGetter;
  readonly requests: readonly SystemStoragePresignedUrlRequest[];
}): Promise<ReadonlyMap<string, SystemStoragePresignedUrlResult>> {
  if (args.requests.length === 0) {
    return new Map();
  }

  const requestsByCacheKey = new Map<
    string,
    SystemStoragePresignedUrlRequest
  >();
  for (const request of args.requests) {
    requestsByCacheKey.set(systemStoragePresignedUrlCacheKey(request), request);
  }

  const cacheKeys = [...requestsByCacheKey.keys()];
  const rows = await args.db
    .select({
      cacheKey: systemStoragePresignedUrlCache.cacheKey,
      presignedUrl: systemStoragePresignedUrlCache.presignedUrl,
      expiresAt: systemStoragePresignedUrlCache.expiresAt,
      refreshAfter: systemStoragePresignedUrlCache.refreshAfter,
      lastRequestedAt: systemStoragePresignedUrlCache.lastRequestedAt,
    })
    .from(systemStoragePresignedUrlCache)
    .where(inArray(systemStoragePresignedUrlCache.cacheKey, cacheKeys));

  const rowByCacheKey = new Map(
    rows.map((row) => {
      return [row.cacheKey, row];
    }),
  );
  const issuedAt = nowDate();
  const safetyCutoff = hardSafetyCutoff(issuedAt);
  const results = new Map<string, SystemStoragePresignedUrlResult>();
  const cacheKeysToTouch: string[] = [];
  const needsFresh: {
    readonly cacheKey: string;
    readonly request: SystemStoragePresignedUrlRequest;
    readonly status: Extract<
      SystemStoragePresignedUrlCacheStatus,
      "miss" | "sync_refresh"
    >;
  }[] = [];

  for (const [cacheKey, request] of requestsByCacheKey) {
    const row = rowByCacheKey.get(cacheKey);
    if (row && row.expiresAt > safetyCutoff) {
      if (row.lastRequestedAt <= touchCutoff(issuedAt)) {
        cacheKeysToTouch.push(cacheKey);
      }
      results.set(cacheKey, {
        cacheKey,
        url: row.presignedUrl,
        status: row.refreshAfter <= issuedAt ? "stale_reuse" : "hit",
      });
      continue;
    }

    needsFresh.push({
      cacheKey,
      request,
      status: row ? "sync_refresh" : "miss",
    });
  }

  const freshValues = await Promise.all(
    needsFresh.map((entry) => {
      return signCacheValue({
        get: args.get,
        request: entry.request,
        cacheKey: entry.cacheKey,
        ttlSeconds: SYSTEM_STORAGE_PRESIGNED_URL_TTL_SECONDS,
        issuedAt,
        lastRequestedAt: issuedAt,
      });
    }),
  );
  await Promise.all([
    upsertCacheValues(args.db, freshValues, { updateLastRequestedAt: true }),
    touchRecentlyUsedCacheRows(args.db, cacheKeysToTouch, issuedAt),
  ]);

  for (let index = 0; index < needsFresh.length; index += 1) {
    const entry = needsFresh[index];
    const value = freshValues[index];
    if (!entry || !value) {
      continue;
    }
    results.set(entry.cacheKey, {
      cacheKey: entry.cacheKey,
      url: value.presignedUrl,
      status: entry.status,
    });
  }

  return results;
}

export async function refreshDueSystemStoragePresignedUrls(args: {
  readonly db: Db;
  readonly get: ComputedGetter;
  readonly limit?: number;
  readonly pruneLimit?: number;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly due: number;
  readonly refreshed: number;
  readonly pruned: number;
}> {
  const limit = args.limit ?? SYSTEM_STORAGE_PRESIGNED_URL_REFRESH_LIMIT;
  const pruneLimit =
    args.pruneLimit ?? SYSTEM_STORAGE_PRESIGNED_URL_PRUNE_LIMIT;
  const issuedAt = nowDate();
  const rows = await args.db
    .select({
      cacheKey: systemStoragePresignedUrlCache.cacheKey,
      bucket: systemStoragePresignedUrlCache.bucket,
      objectKey: systemStoragePresignedUrlCache.objectKey,
      storageVersionId: systemStoragePresignedUrlCache.storageVersionId,
      publicEndpoint: systemStoragePresignedUrlCache.publicEndpoint,
      ttlSeconds: systemStoragePresignedUrlCache.ttlSeconds,
      lastRequestedAt: systemStoragePresignedUrlCache.lastRequestedAt,
    })
    .from(systemStoragePresignedUrlCache)
    .where(
      and(
        lte(systemStoragePresignedUrlCache.refreshAfter, issuedAt),
        gte(
          systemStoragePresignedUrlCache.lastRequestedAt,
          activeCutoff(issuedAt),
        ),
      ),
    )
    .orderBy(
      asc(systemStoragePresignedUrlCache.refreshAfter),
      asc(systemStoragePresignedUrlCache.expiresAt),
    )
    .limit(limit);
  args.signal?.throwIfAborted();

  const freshValues = await Promise.all(
    rows.map((row) => {
      return signCacheValue({
        get: args.get,
        cacheKey: row.cacheKey,
        ttlSeconds: row.ttlSeconds,
        issuedAt,
        request: {
          bucket: row.bucket,
          objectKey: row.objectKey,
          storageVersionId: row.storageVersionId,
          publicEndpoint: row.publicEndpoint,
        },
        lastRequestedAt: row.lastRequestedAt,
      });
    }),
  );
  args.signal?.throwIfAborted();
  await upsertCacheValues(args.db, freshValues, {
    updateLastRequestedAt: false,
  });
  args.signal?.throwIfAborted();

  const pruned = await pruneInactiveExpiredCacheRows(
    args.db,
    issuedAt,
    pruneLimit,
    args.signal,
  );

  return { due: rows.length, refreshed: freshValues.length, pruned };
}
