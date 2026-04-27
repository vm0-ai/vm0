import { eq, and, isNotNull } from "drizzle-orm";
import { storages } from "@vm0/db/schema/storage";
import { exportJobs } from "@vm0/db/schema/export-job";
import { listS3Objects, deleteS3Objects } from "../../infra/s3/s3-client";
import { logger } from "../../shared/logger";

const log = logger("service:org-s3-cleanup");

/**
 * Delete all S3 objects belonging to an org.
 * Must be called BEFORE database deletion — reads s3Prefix/s3Key from DB.
 * Idempotent: deleting non-existent S3 objects is a no-op.
 */
export async function deleteOrgS3Data(orgId: string): Promise<void> {
  const db = globalThis.services.db;
  const bucket = globalThis.services.env.R2_USER_STORAGES_BUCKET_NAME;

  // 1. Delete storage objects (artifacts, memory, volumes)
  const orgStorages = await db
    .select({ s3Prefix: storages.s3Prefix })
    .from(storages)
    .where(eq(storages.orgId, orgId));

  for (const storage of orgStorages) {
    const objects = await listS3Objects(bucket, storage.s3Prefix);
    if (objects.length > 0) {
      await deleteS3Objects(
        bucket,
        objects.map((o) => {
          return o.key;
        }),
      );
      log.debug("deleted storage objects", {
        prefix: storage.s3Prefix,
        count: objects.length,
      });
    }
  }

  // 2. Delete export job ZIPs
  const orgExports = await db
    .select({ s3Key: exportJobs.s3Key })
    .from(exportJobs)
    .where(and(eq(exportJobs.orgId, orgId), isNotNull(exportJobs.s3Key)));

  const exportKeys = orgExports
    .map((e) => {
      return e.s3Key;
    })
    .filter((k): k is string => {
      return k !== null;
    });

  if (exportKeys.length > 0) {
    await deleteS3Objects(bucket, exportKeys);
    log.debug("deleted export objects", { count: exportKeys.length });
  }

  log.info("org S3 data deleted", {
    orgId,
    storageCount: orgStorages.length,
    exportCount: exportKeys.length,
  });
}
