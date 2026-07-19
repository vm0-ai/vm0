import {
  testStorageArchiveSizeBackfillStateContract,
  type TestStorageArchiveSizeBackfillStateActionBody,
  type TestStorageArchiveSizeBackfillVersionSeed,
} from "@vm0/api-contracts/contracts/test-storage-archive-size-backfill-state";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@vm0/core/storage-names";
import { storageArchiveSizeBackfillWork } from "@vm0/db/schema/storage-archive-size-backfill";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { command } from "ccstate";
import { eq, inArray, like, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(
  testStorageArchiveSizeBackfillStateContract.action,
);

type BackfillStateAction<
  TAction extends TestStorageArchiveSizeBackfillStateActionBody["action"],
> = Extract<TestStorageArchiveSizeBackfillStateActionBody, { action: TAction }>;

function actionOk(extra: Record<string, unknown> = {}) {
  return { status: 200 as const, body: { ok: true as const, ...extra } };
}

async function seedStorages(
  db: Db,
  versions: readonly TestStorageArchiveSizeBackfillVersionSeed[],
) {
  const rows = await db
    .insert(storages)
    .values(
      versions.map((version) => {
        return {
          orgId: SYSTEM_ORG_ID,
          userId: VOLUME_ORG_USER_ID,
          name: version.storage_name,
          type: "volume",
          s3Prefix: version.s3_key,
          size: version.file_count,
          fileCount: version.file_count,
        };
      }),
    )
    .returning({ id: storages.id, name: storages.name });

  return new Map(
    rows.map((row) => {
      return [row.name, row.id];
    }),
  );
}

async function seedForAction(
  db: Db,
  body: BackfillStateAction<"seed">,
  signal: AbortSignal,
) {
  const storageIdsByName = await seedStorages(db, body.versions);
  signal.throwIfAborted();

  await db.insert(storageVersions).values(
    body.versions.map((version) => {
      const storageId = storageIdsByName.get(version.storage_name);
      if (!storageId) {
        throw new Error(`Missing seeded storage ${version.storage_name}`);
      }
      return {
        id: version.id,
        storageId,
        s3Key: version.s3_key,
        size: version.file_count,
        archiveSize: version.archive_size,
        fileCount: version.file_count,
        message: "Seeded by storage archive size backfill route test",
        createdBy: "system",
      };
    }),
  );
  signal.throwIfAborted();
  return actionOk();
}

async function readForAction(
  db: Db,
  body: BackfillStateAction<"read">,
  signal: AbortSignal,
) {
  if (body.version_ids.length === 0) {
    return actionOk({ versions: [] });
  }

  const rows = await db
    .select({
      id: storageVersions.id,
      archiveSize: storageVersions.archiveSize,
      fileCount: storageVersions.fileCount,
      claimToken: storageArchiveSizeBackfillWork.claimToken,
      leaseExpiresAt: storageArchiveSizeBackfillWork.leaseExpiresAt,
      attemptCount: storageArchiveSizeBackfillWork.attemptCount,
      outcome: storageArchiveSizeBackfillWork.outcome,
      errorCode: storageArchiveSizeBackfillWork.errorCode,
    })
    .from(storageVersions)
    .leftJoin(
      storageArchiveSizeBackfillWork,
      eq(storageArchiveSizeBackfillWork.storageVersionId, storageVersions.id),
    )
    .where(inArray(storageVersions.id, body.version_ids))
    .orderBy(storageVersions.id);
  signal.throwIfAborted();

  return actionOk({
    versions: rows.map((row) => {
      return {
        id: row.id,
        archive_size: row.archiveSize,
        file_count: row.fileCount,
        work:
          row.claimToken && row.leaseExpiresAt && row.attemptCount
            ? {
                claim_token: row.claimToken,
                lease_expires_at: row.leaseExpiresAt.toISOString(),
                attempt_count: row.attemptCount,
                outcome: row.outcome,
                error_code: row.errorCode,
              }
            : null,
      };
    }),
  });
}

async function expireClaimsForAction(
  db: Db,
  body: BackfillStateAction<"expire-claims">,
  signal: AbortSignal,
) {
  await db
    .update(storageArchiveSizeBackfillWork)
    .set({ leaseExpiresAt: new Date(nowDate().getTime() - 1) })
    .where(
      inArray(
        storageArchiveSizeBackfillWork.storageVersionId,
        body.version_ids,
      ),
    );
  signal.throwIfAborted();
  return actionOk();
}

async function setArchiveSizeForAction(
  db: Db,
  body: BackfillStateAction<"set-archive-size">,
  signal: AbortSignal,
) {
  await db
    .update(storageVersions)
    .set({ archiveSize: body.archive_size })
    .where(eq(storageVersions.id, body.version_id));
  signal.throwIfAborted();
  return actionOk();
}

async function cleanupForAction(
  db: Db,
  body: BackfillStateAction<"cleanup">,
  signal: AbortSignal,
) {
  await db
    .delete(storages)
    .where(like(storages.name, `${body.storage_name_prefix}%`));
  signal.throwIfAborted();
  return actionOk();
}

async function retireTemporaryTablesForAction(db: Db, signal: AbortSignal) {
  await db.execute(
    sql`ALTER TABLE storage_archive_size_backfill_work
      RENAME TO storage_archive_size_backfill_work_retired_test`,
  );
  signal.throwIfAborted();
  return actionOk();
}

async function restoreTemporaryTablesForAction(db: Db, signal: AbortSignal) {
  await db.execute(
    sql`ALTER TABLE IF EXISTS storage_archive_size_backfill_work_retired_test
      RENAME TO storage_archive_size_backfill_work`,
  );
  signal.throwIfAborted();
  return actionOk();
}

const mutateStorageArchiveSizeBackfillState$ = command(
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
      case "seed": {
        return await seedForAction(db, body, signal);
      }
      case "read": {
        return await readForAction(db, body, signal);
      }
      case "expire-claims": {
        return await expireClaimsForAction(db, body, signal);
      }
      case "set-archive-size": {
        return await setArchiveSizeForAction(db, body, signal);
      }
      case "cleanup": {
        return await cleanupForAction(db, body, signal);
      }
      case "retire-temporary-tables": {
        return await retireTemporaryTablesForAction(db, signal);
      }
      case "restore-temporary-tables": {
        return await restoreTemporaryTablesForAction(db, signal);
      }
    }
  },
);

export const testStorageArchiveSizeBackfillStateRoutes: readonly RouteEntry[] =
  [
    {
      route: testStorageArchiveSizeBackfillStateContract.action,
      handler: mutateStorageArchiveSizeBackfillState$,
    },
  ];
