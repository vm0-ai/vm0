import {
  testWorkflowSkillStoragePresignedUrlCacheStateContract,
  type TestWorkflowSkillStoragePresignedUrlCacheStateActionBody,
} from "@vm0/api-contracts/contracts/test-workflow-skill-storage-presigned-url-cache-state";
import { systemStoragePresignedUrlCache } from "@vm0/db/schema/system-storage-presigned-url-cache";
import { command } from "ccstate";
import { and, eq, like, sql } from "drizzle-orm";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { workflowSkillStoragePresignedUrlCacheKey } from "../services/system-storage-presigned-url-cache.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(
  testWorkflowSkillStoragePresignedUrlCacheStateContract.action,
);

type CacheStateAction<
  TAction extends
    TestWorkflowSkillStoragePresignedUrlCacheStateActionBody["action"],
> = Extract<
  TestWorkflowSkillStoragePresignedUrlCacheStateActionBody,
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
  return and(
    eq(systemStoragePresignedUrlCache.scope, "workflow_skill_storage"),
    sql`${like(systemStoragePresignedUrlCache.objectKey, escapedLikePrefix(prefix))} escape '\\'`,
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

async function seedCacheRowForAction(
  db: Db,
  body: CacheStateAction<"seed-cache-row">,
  signal: AbortSignal,
) {
  await db
    .insert(systemStoragePresignedUrlCache)
    .values({
      cacheKey: workflowSkillStoragePresignedUrlCacheKey({
        bucket: body.bucket,
        objectKey: body.object_key,
        storageVersionId: body.storage_version_id,
        resolvedOrgId: body.resolved_org_id,
        publicEndpoint: body.public_endpoint,
      }),
      scope: "workflow_skill_storage",
      bucket: body.bucket,
      objectKey: body.object_key,
      storageVersionId: body.storage_version_id,
      resolvedOrgId: body.resolved_org_id,
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
      resolvedOrgId: systemStoragePresignedUrlCache.resolvedOrgId,
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
        resolved_org_id: row.resolvedOrgId,
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

const mutateWorkflowSkillStoragePresignedUrlCacheState$ = command(
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
      case "seed-cache-row": {
        return await seedCacheRowForAction(db, body, signal);
      }
      case "read-cache-by-object-key-prefix": {
        return await readCacheByObjectKeyPrefixForAction(db, body, signal);
      }
    }
  },
);

export const testWorkflowSkillStoragePresignedUrlCacheStateRoutes: readonly RouteEntry[] =
  [
    {
      route: testWorkflowSkillStoragePresignedUrlCacheStateContract.action,
      handler: mutateWorkflowSkillStoragePresignedUrlCacheState$,
    },
  ];
