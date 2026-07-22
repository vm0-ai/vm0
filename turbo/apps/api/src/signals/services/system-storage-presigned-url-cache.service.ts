import { createHash } from "node:crypto";

import { systemStoragePresignedUrlCache } from "@vm0/db/schema/system-storage-presigned-url-cache";
import type { Computed } from "ccstate";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { executeRawRows } from "../../lib/db-raw-rows";
import type { Db } from "../external/db";
import { generatePresignedGetUrl } from "../external/s3";
import { nowDate, timestampWithoutTimeZone } from "../external/time";

type ComputedGetter = <T>(computedValue: Computed<T>) => T;
type StoragePresignedUrlCacheScope =
  | "system_storage"
  | "workflow_skill_storage";

export const SYSTEM_STORAGE_PRESIGNED_URL_TTL_SECONDS = 2 * 60 * 60;
const SYSTEM_STORAGE_PRESIGNED_URL_HARD_SAFETY_WINDOW_SECONDS = 15 * 60;
const SYSTEM_STORAGE_PRESIGNED_URL_REFRESH_BASE_SECONDS = 20 * 60;
const SYSTEM_STORAGE_PRESIGNED_URL_REFRESH_JITTER_SECONDS = 30 * 60;
const SYSTEM_STORAGE_PRESIGNED_URL_TOUCH_INTERVAL_SECONDS = 30 * 60;
const SYSTEM_STORAGE_PRESIGNED_URL_ACTIVE_WINDOW_SECONDS = 24 * 60 * 60;
const SYSTEM_STORAGE_PRESIGNED_URL_CACHE_POLICY = "system-storage-url-v1";
export const SYSTEM_STORAGE_PRESIGNED_URL_REFRESH_LIMIT = 3;
export const SYSTEM_STORAGE_PRESIGNED_URL_PRUNE_LIMIT = 100;

export const WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_TTL_SECONDS = 2 * 60 * 60;
const WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_CACHE_POLICY =
  "workflow-skill-storage-url-v1";
export const WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_REFRESH_LIMIT = 32;
export const WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_PRUNE_LIMIT = 100;
const deletedCacheRowSchema = z.object({ cacheKey: z.string() });

type StoragePresignedUrlCacheStatus =
  | "hit"
  | "stale_reuse"
  | "miss"
  | "sync_refresh";

export type SystemStoragePresignedUrlCacheStatus =
  StoragePresignedUrlCacheStatus;
export type WorkflowSkillStoragePresignedUrlCacheStatus =
  StoragePresignedUrlCacheStatus;

export interface SystemStoragePresignedUrlRequest {
  readonly bucket: string;
  readonly objectKey: string;
  readonly storageVersionId: string;
  readonly publicEndpoint: boolean;
}

export interface WorkflowSkillStoragePresignedUrlRequest {
  readonly bucket: string;
  readonly objectKey: string;
  readonly storageVersionId: string;
  readonly resolvedOrgId: string;
  readonly publicEndpoint: boolean;
}

interface StoragePresignedUrlRequest {
  readonly scope: StoragePresignedUrlCacheScope;
  readonly bucket: string;
  readonly objectKey: string;
  readonly storageVersionId: string;
  readonly resolvedOrgId: string | null;
  readonly publicEndpoint: boolean;
}

interface StoragePresignedUrlResult {
  readonly cacheKey: string;
  readonly url: string;
  readonly status: StoragePresignedUrlCacheStatus;
}

interface CacheRowValue {
  readonly cacheKey: string;
  readonly scope: StoragePresignedUrlCacheScope;
  readonly bucket: string;
  readonly objectKey: string;
  readonly storageVersionId: string;
  readonly resolvedOrgId: string | null;
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

export function workflowSkillStoragePresignedUrlCacheKey(
  request: WorkflowSkillStoragePresignedUrlRequest,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_CACHE_POLICY,
        request.bucket,
        request.objectKey,
        request.storageVersionId,
        request.resolvedOrgId,
        request.publicEndpoint ? "public" : "private",
        WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_TTL_SECONDS,
      ]),
    )
    .digest("hex");
}

function systemStorageRequest(
  request: SystemStoragePresignedUrlRequest,
): StoragePresignedUrlRequest {
  return {
    scope: "system_storage",
    bucket: request.bucket,
    objectKey: request.objectKey,
    storageVersionId: request.storageVersionId,
    resolvedOrgId: null,
    publicEndpoint: request.publicEndpoint,
  };
}

function workflowSkillStorageRequest(
  request: WorkflowSkillStoragePresignedUrlRequest,
): StoragePresignedUrlRequest {
  return {
    scope: "workflow_skill_storage",
    bucket: request.bucket,
    objectKey: request.objectKey,
    storageVersionId: request.storageVersionId,
    resolvedOrgId: request.resolvedOrgId,
    publicEndpoint: request.publicEndpoint,
  };
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

function storagePresignedUrlCacheScope(
  value: string,
): StoragePresignedUrlCacheScope {
  if (value === "system_storage" || value === "workflow_skill_storage") {
    return value;
  }
  throw new Error(`Unexpected storage presigned URL cache scope: ${value}`);
}

async function signCacheValue(args: {
  readonly get: ComputedGetter;
  readonly request: StoragePresignedUrlRequest;
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
    scope: args.request.scope,
    bucket: args.request.bucket,
    objectKey: args.request.objectKey,
    storageVersionId: args.request.storageVersionId,
    resolvedOrgId: args.request.resolvedOrgId,
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
  const orderedValues = [...values].sort((left, right) => {
    return left.cacheKey.localeCompare(right.cacheKey);
  });
  const set = {
    scope: sql`excluded.scope`,
    bucket: sql`excluded.bucket`,
    objectKey: sql`excluded.object_key`,
    storageVersionId: sql`excluded.storage_version_id`,
    resolvedOrgId: sql`excluded.resolved_org_id`,
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
      orderedValues.map((value) => {
        return {
          cacheKey: value.cacheKey,
          scope: value.scope,
          bucket: value.bucket,
          objectKey: value.objectKey,
          storageVersionId: value.storageVersionId,
          resolvedOrgId: value.resolvedOrgId,
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
  const orderedCacheKeys = [...cacheKeys].sort((left, right) => {
    return left.localeCompare(right);
  });
  const issuedAtTimestamp = timestampWithoutTimeZone(issuedAt);
  const touchCutoffTimestamp = timestampWithoutTimeZone(touchCutoff(issuedAt));
  await db.execute(sql`
    WITH locked AS (
      SELECT ${systemStoragePresignedUrlCache.cacheKey}
      FROM ${systemStoragePresignedUrlCache}
      WHERE
        ${inArray(systemStoragePresignedUrlCache.cacheKey, orderedCacheKeys)}
        AND ${lte(systemStoragePresignedUrlCache.lastRequestedAt, sql`${touchCutoffTimestamp}::timestamp`)}
      ORDER BY ${systemStoragePresignedUrlCache.cacheKey}
      FOR UPDATE OF ${systemStoragePresignedUrlCache}
    )
    UPDATE ${systemStoragePresignedUrlCache}
    SET last_requested_at = ${issuedAtTimestamp}::timestamp
    FROM locked
    WHERE ${systemStoragePresignedUrlCache.cacheKey} = locked.cache_key
  `);
}

async function pruneInactiveExpiredCacheRows(
  db: Db,
  scope: StoragePresignedUrlCacheScope,
  issuedAt: Date,
  limit: number,
  signal?: AbortSignal,
): Promise<number> {
  const inactiveCutoff = activeCutoff(issuedAt);
  const issuedAtTimestamp = timestampWithoutTimeZone(issuedAt);
  const inactiveCutoffTimestamp = timestampWithoutTimeZone(inactiveCutoff);
  const deletedRows = await executeRawRows(
    db,
    sql`
      WITH candidates AS (
      SELECT ${systemStoragePresignedUrlCache.cacheKey} AS "cacheKey"
      FROM ${systemStoragePresignedUrlCache}
      WHERE
        ${eq(systemStoragePresignedUrlCache.scope, scope)}
        AND ${lte(systemStoragePresignedUrlCache.expiresAt, sql`${issuedAtTimestamp}::timestamp`)}
        AND ${lte(systemStoragePresignedUrlCache.lastRequestedAt, sql`${inactiveCutoffTimestamp}::timestamp`)}
      ORDER BY
        ${systemStoragePresignedUrlCache.lastRequestedAt},
        ${systemStoragePresignedUrlCache.expiresAt},
        ${systemStoragePresignedUrlCache.cacheKey}
      LIMIT ${limit}
    ),
    locked AS (
      SELECT ${systemStoragePresignedUrlCache.cacheKey} AS "cacheKey"
      FROM ${systemStoragePresignedUrlCache}
      INNER JOIN candidates
        ON ${systemStoragePresignedUrlCache.cacheKey} = candidates."cacheKey"
      WHERE
        ${eq(systemStoragePresignedUrlCache.scope, scope)}
        AND ${lte(systemStoragePresignedUrlCache.expiresAt, sql`${issuedAtTimestamp}::timestamp`)}
        AND ${lte(systemStoragePresignedUrlCache.lastRequestedAt, sql`${inactiveCutoffTimestamp}::timestamp`)}
      ORDER BY ${systemStoragePresignedUrlCache.cacheKey}
      FOR UPDATE OF ${systemStoragePresignedUrlCache}
    )
    DELETE FROM ${systemStoragePresignedUrlCache}
    USING locked
    WHERE ${systemStoragePresignedUrlCache.cacheKey} = locked."cacheKey"
      RETURNING ${systemStoragePresignedUrlCache.cacheKey} AS "cacheKey"
    `,
    deletedCacheRowSchema,
  );
  signal?.throwIfAborted();
  return deletedRows.length;
}

async function resolveStoragePresignedUrls<TRequest>(args: {
  readonly db: Db;
  readonly get: ComputedGetter;
  readonly scope: StoragePresignedUrlCacheScope;
  readonly requests: readonly TRequest[];
  readonly ttlSeconds: number;
  readonly cacheKey: (request: TRequest) => string;
  readonly normalize: (request: TRequest) => StoragePresignedUrlRequest;
}): Promise<ReadonlyMap<string, StoragePresignedUrlResult>> {
  if (args.requests.length === 0) {
    return new Map();
  }

  const requestsByCacheKey = new Map<string, StoragePresignedUrlRequest>();
  for (const request of args.requests) {
    requestsByCacheKey.set(args.cacheKey(request), args.normalize(request));
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
    .where(
      and(
        eq(systemStoragePresignedUrlCache.scope, args.scope),
        inArray(systemStoragePresignedUrlCache.cacheKey, cacheKeys),
      ),
    );

  const rowByCacheKey = new Map(
    rows.map((row) => {
      return [row.cacheKey, row];
    }),
  );
  const issuedAt = nowDate();
  const safetyCutoff = hardSafetyCutoff(issuedAt);
  const results = new Map<string, StoragePresignedUrlResult>();
  const cacheKeysToTouch: string[] = [];
  const needsFresh: {
    readonly cacheKey: string;
    readonly request: StoragePresignedUrlRequest;
    readonly status: Extract<
      StoragePresignedUrlCacheStatus,
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
        ttlSeconds: args.ttlSeconds,
        issuedAt,
        lastRequestedAt: issuedAt,
      });
    }),
  );
  await upsertCacheValues(args.db, freshValues, {
    updateLastRequestedAt: true,
  });
  await touchRecentlyUsedCacheRows(args.db, cacheKeysToTouch, issuedAt);

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

async function refreshDueStoragePresignedUrls(args: {
  readonly db: Db;
  readonly get: ComputedGetter;
  readonly scope: StoragePresignedUrlCacheScope;
  readonly limit: number;
  readonly pruneLimit: number;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly due: number;
  readonly refreshed: number;
  readonly pruned: number;
}> {
  const issuedAt = nowDate();
  const rows = await args.db
    .select({
      cacheKey: systemStoragePresignedUrlCache.cacheKey,
      scope: systemStoragePresignedUrlCache.scope,
      bucket: systemStoragePresignedUrlCache.bucket,
      objectKey: systemStoragePresignedUrlCache.objectKey,
      storageVersionId: systemStoragePresignedUrlCache.storageVersionId,
      resolvedOrgId: systemStoragePresignedUrlCache.resolvedOrgId,
      publicEndpoint: systemStoragePresignedUrlCache.publicEndpoint,
      ttlSeconds: systemStoragePresignedUrlCache.ttlSeconds,
      lastRequestedAt: systemStoragePresignedUrlCache.lastRequestedAt,
    })
    .from(systemStoragePresignedUrlCache)
    .where(
      and(
        eq(systemStoragePresignedUrlCache.scope, args.scope),
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
    .limit(args.limit + 1);
  args.signal?.throwIfAborted();

  const rowsToRefresh = rows.slice(0, args.limit);
  const freshValues = await Promise.all(
    rowsToRefresh.map((row) => {
      return signCacheValue({
        get: args.get,
        cacheKey: row.cacheKey,
        ttlSeconds: row.ttlSeconds,
        issuedAt,
        request: {
          scope: storagePresignedUrlCacheScope(row.scope),
          bucket: row.bucket,
          objectKey: row.objectKey,
          storageVersionId: row.storageVersionId,
          resolvedOrgId: row.resolvedOrgId,
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
    args.scope,
    issuedAt,
    args.pruneLimit,
    args.signal,
  );

  return { due: rows.length, refreshed: freshValues.length, pruned };
}

export async function resolveSystemStoragePresignedUrls(args: {
  readonly db: Db;
  readonly get: ComputedGetter;
  readonly requests: readonly SystemStoragePresignedUrlRequest[];
}): Promise<ReadonlyMap<string, StoragePresignedUrlResult>> {
  return await resolveStoragePresignedUrls({
    ...args,
    scope: "system_storage",
    ttlSeconds: SYSTEM_STORAGE_PRESIGNED_URL_TTL_SECONDS,
    cacheKey: systemStoragePresignedUrlCacheKey,
    normalize: systemStorageRequest,
  });
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
  return await refreshDueStoragePresignedUrls({
    db: args.db,
    get: args.get,
    scope: "system_storage",
    limit: args.limit ?? SYSTEM_STORAGE_PRESIGNED_URL_REFRESH_LIMIT,
    pruneLimit: args.pruneLimit ?? SYSTEM_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
    signal: args.signal,
  });
}

export async function resolveWorkflowSkillStoragePresignedUrls(args: {
  readonly db: Db;
  readonly get: ComputedGetter;
  readonly requests: readonly WorkflowSkillStoragePresignedUrlRequest[];
}): Promise<ReadonlyMap<string, StoragePresignedUrlResult>> {
  return await resolveStoragePresignedUrls({
    ...args,
    scope: "workflow_skill_storage",
    ttlSeconds: WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_TTL_SECONDS,
    cacheKey: workflowSkillStoragePresignedUrlCacheKey,
    normalize: workflowSkillStorageRequest,
  });
}

export async function refreshDueWorkflowSkillStoragePresignedUrls(args: {
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
  return await refreshDueStoragePresignedUrls({
    db: args.db,
    get: args.get,
    scope: "workflow_skill_storage",
    limit: args.limit ?? WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_REFRESH_LIMIT,
    pruneLimit:
      args.pruneLimit ?? WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
    signal: args.signal,
  });
}
