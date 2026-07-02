import {
  testSystemStoragePresignedUrlCacheStateContract,
  type TestSystemStoragePresignedUrlCacheStateActionBody,
} from "@vm0/api-contracts/contracts/test-system-storage-presigned-url-cache-state";
import { systemStoragePresignedUrlCache } from "@vm0/db/schema/system-storage-presigned-url-cache";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";

import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { systemStoragePresignedUrlCacheKey } from "../services/system-storage-presigned-url-cache.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(
  testSystemStoragePresignedUrlCacheStateContract.action,
);

type CacheStateAction<
  TAction extends TestSystemStoragePresignedUrlCacheStateActionBody["action"],
> = Extract<
  TestSystemStoragePresignedUrlCacheStateActionBody,
  { action: TAction }
>;

function actionOk(extra: Record<string, unknown> = {}) {
  return { status: 200 as const, body: { ok: true as const, ...extra } };
}

function escapedLikePrefix(value: string): string {
  return `${value
    .replaceAll("\\", String.raw`\\`)
    .replaceAll("%", String.raw`\%`)
    .replaceAll("_", String.raw`\_`)}%`;
}

function objectKeyPrefixCondition(prefix: string) {
  return sql`${systemStoragePresignedUrlCache.objectKey} like ${escapedLikePrefix(prefix)} escape '\\'`;
}

function storageIdentityCondition(body: {
  readonly org_id: string;
  readonly user_id: string;
  readonly storage_name: string;
}) {
  return and(
    eq(storages.orgId, body.org_id),
    eq(storages.userId, body.user_id),
    eq(storages.name, body.storage_name),
    eq(storages.type, "volume"),
  );
}

async function cleanupForAction(
  db: Db,
  body: CacheStateAction<"cleanup">,
  signal: AbortSignal,
) {
  await db
    .delete(systemStoragePresignedUrlCache)
    .where(objectKeyPrefixCondition(body.object_key_prefix));
  signal.throwIfAborted();
  return actionOk();
}

async function readStorageStateForAction(
  db: Db,
  body: CacheStateAction<"read-storage-state">,
  signal: AbortSignal,
) {
  const [storage] = await db
    .select({
      s3Prefix: storages.s3Prefix,
      size: storages.size,
      fileCount: storages.fileCount,
      headVersionId: storages.headVersionId,
    })
    .from(storages)
    .where(storageIdentityCondition(body))
    .limit(1);
  signal.throwIfAborted();
  return actionOk({
    storage_state: storage
      ? {
          s3_prefix: storage.s3Prefix,
          size: storage.size,
          file_count: storage.fileCount,
          head_version_id: storage.headVersionId,
        }
      : null,
  });
}

async function restoreStorageStateForAction(
  db: Db,
  body: CacheStateAction<"restore-storage-state">,
  signal: AbortSignal,
) {
  if (!body.previous) {
    await db.delete(storages).where(storageIdentityCondition(body));
    signal.throwIfAborted();
    return actionOk();
  }

  const restored = await db
    .update(storages)
    .set({
      s3Prefix: body.previous.s3_prefix,
      size: body.previous.size,
      fileCount: body.previous.file_count,
      headVersionId: body.previous.head_version_id,
    })
    .where(storageIdentityCondition(body))
    .returning({ id: storages.id });
  signal.throwIfAborted();
  if (restored.length === 0) {
    throw new Error("Failed to restore storage state");
  }
  return actionOk();
}

async function seedStorageVersionForAction(
  db: Db,
  body: CacheStateAction<"seed-storage-version">,
  signal: AbortSignal,
) {
  const [storage] = await db
    .insert(storages)
    .values({
      orgId: body.org_id,
      userId: body.user_id,
      name: body.storage_name,
      type: "volume",
      s3Prefix: body.s3_prefix,
      size: 1,
      fileCount: 1,
    })
    .onConflictDoUpdate({
      target: [storages.orgId, storages.userId, storages.name, storages.type],
      set: {
        s3Prefix: sql`excluded.s3_prefix`,
        size: sql`excluded.size`,
        fileCount: sql`excluded.file_count`,
      },
    })
    .returning({ id: storages.id });
  signal.throwIfAborted();
  if (!storage) {
    throw new Error("Failed to seed storage");
  }

  await db
    .insert(storageVersions)
    .values({
      id: body.version_id,
      storageId: storage.id,
      s3Key: body.s3_key,
      size: 1,
      fileCount: 1,
      message: "Seeded by system storage presigned URL cache route test",
      createdBy: "test",
    })
    .onConflictDoUpdate({
      target: storageVersions.id,
      set: {
        storageId: sql`excluded.storage_id`,
        s3Key: sql`excluded.s3_key`,
        size: sql`excluded.size`,
        fileCount: sql`excluded.file_count`,
      },
    });
  signal.throwIfAborted();

  await db
    .update(storages)
    .set({ headVersionId: body.version_id })
    .where(eq(storages.id, storage.id));
  signal.throwIfAborted();
  return actionOk();
}

async function deleteStorageVersionForAction(
  db: Db,
  body: CacheStateAction<"delete-storage-version">,
  signal: AbortSignal,
) {
  const [storage] = await db
    .select({ id: storages.id })
    .from(storages)
    .where(storageIdentityCondition(body))
    .limit(1);
  signal.throwIfAborted();
  if (!storage) {
    return actionOk();
  }

  await db
    .delete(storageVersions)
    .where(
      and(
        eq(storageVersions.id, body.version_id),
        eq(storageVersions.storageId, storage.id),
      ),
    );
  signal.throwIfAborted();
  return actionOk();
}

async function seedCacheRowForAction(
  db: Db,
  body: CacheStateAction<"seed-cache-row">,
  signal: AbortSignal,
) {
  await db
    .insert(systemStoragePresignedUrlCache)
    .values({
      cacheKey: systemStoragePresignedUrlCacheKey({
        bucket: body.bucket,
        objectKey: body.object_key,
        storageVersionId: body.storage_version_id,
        publicEndpoint: body.public_endpoint,
      }),
      bucket: body.bucket,
      objectKey: body.object_key,
      storageVersionId: body.storage_version_id,
      publicEndpoint: body.public_endpoint,
      ttlSeconds: body.ttl_seconds,
      presignedUrl: body.presigned_url,
      expiresAt: new Date(body.expires_at),
      refreshAfter: new Date(body.refresh_after),
      lastRequestedAt: new Date(body.last_requested_at ?? body.refresh_after),
      updatedAt: new Date(body.refresh_after),
    })
    .onConflictDoUpdate({
      target: systemStoragePresignedUrlCache.cacheKey,
      set: {
        bucket: sql`excluded.bucket`,
        objectKey: sql`excluded.object_key`,
        storageVersionId: sql`excluded.storage_version_id`,
        publicEndpoint: sql`excluded.public_endpoint`,
        ttlSeconds: sql`excluded.ttl_seconds`,
        presignedUrl: sql`excluded.presigned_url`,
        expiresAt: sql`excluded.expires_at`,
        refreshAfter: sql`excluded.refresh_after`,
        lastRequestedAt: sql`excluded.last_requested_at`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
  signal.throwIfAborted();
  return actionOk();
}

async function readCacheByObjectKeyPrefixForAction(
  db: Db,
  body: CacheStateAction<"read-cache-by-object-key-prefix">,
  signal: AbortSignal,
) {
  const rows = await db
    .select({
      cacheKey: systemStoragePresignedUrlCache.cacheKey,
      bucket: systemStoragePresignedUrlCache.bucket,
      objectKey: systemStoragePresignedUrlCache.objectKey,
      storageVersionId: systemStoragePresignedUrlCache.storageVersionId,
      publicEndpoint: systemStoragePresignedUrlCache.publicEndpoint,
      ttlSeconds: systemStoragePresignedUrlCache.ttlSeconds,
      presignedUrl: systemStoragePresignedUrlCache.presignedUrl,
      expiresAt: systemStoragePresignedUrlCache.expiresAt,
      refreshAfter: systemStoragePresignedUrlCache.refreshAfter,
      lastRequestedAt: systemStoragePresignedUrlCache.lastRequestedAt,
    })
    .from(systemStoragePresignedUrlCache)
    .where(objectKeyPrefixCondition(body.object_key_prefix));
  signal.throwIfAborted();
  return actionOk({
    rows: rows.map((row) => {
      return {
        cache_key: row.cacheKey,
        bucket: row.bucket,
        object_key: row.objectKey,
        storage_version_id: row.storageVersionId,
        public_endpoint: row.publicEndpoint,
        ttl_seconds: row.ttlSeconds,
        presigned_url: row.presignedUrl,
        expires_at: row.expiresAt.toISOString(),
        refresh_after: row.refreshAfter.toISOString(),
        last_requested_at: row.lastRequestedAt.toISOString(),
      };
    }),
  });
}

const mutateSystemStoragePresignedUrlCacheState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    const body = bodyResult.data;
    switch (body.action) {
      case "cleanup": {
        return await cleanupForAction(db, body, signal);
      }
      case "read-storage-state": {
        return await readStorageStateForAction(db, body, signal);
      }
      case "restore-storage-state": {
        return await restoreStorageStateForAction(db, body, signal);
      }
      case "seed-storage-version": {
        return await seedStorageVersionForAction(db, body, signal);
      }
      case "delete-storage-version": {
        return await deleteStorageVersionForAction(db, body, signal);
      }
      case "seed-cache-row": {
        return await seedCacheRowForAction(db, body, signal);
      }
      case "read-cache-by-object-key-prefix": {
        return await readCacheByObjectKeyPrefixForAction(db, body, signal);
      }
    }
  },
);

export const testSystemStoragePresignedUrlCacheStateRoutes: readonly RouteEntry[] =
  [
    {
      route: testSystemStoragePresignedUrlCacheStateContract.action,
      handler: mutateSystemStoragePresignedUrlCacheState$,
    },
  ];
