import { eq, and, isNotNull } from "drizzle-orm";
import { storages } from "@vm0/db/schema/storage";
import { exportJobs } from "@vm0/db/schema/export-job";
import { listS3Objects, deleteS3Objects } from "../../infra/s3/s3-client";
import { logger } from "../../shared/logger";

const log = logger("service:user-s3-cleanup");

/**
 * Delete all S3 objects belonging to a user.
 * Must be called BEFORE database deletion — reads s3Prefix/s3Key from DB.
 * All operations are best-effort: individual failures are logged but do not stop other steps.
 * Idempotent: deleting non-existent S3 objects is a no-op.
 */
export async function deleteUserS3Data(userId: string): Promise<void> {
  const db = globalThis.services.db;
  const bucket = globalThis.services.env.R2_USER_STORAGES_BUCKET_NAME;

  // 1. Delete user's storage objects (artifacts, memory — NOT volumes which use __org__)
  const userStorages = await db
    .select({ s3Prefix: storages.s3Prefix })
    .from(storages)
    .where(eq(storages.userId, userId));

  for (const storage of userStorages) {
    try {
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
    } catch (error) {
      log.error("failed to delete storage objects (best-effort)", {
        userId,
        prefix: storage.s3Prefix,
        error,
      });
    }
  }

  // 2. Delete user's export job ZIPs
  const userExports = await db
    .select({ s3Key: exportJobs.s3Key })
    .from(exportJobs)
    .where(and(eq(exportJobs.userId, userId), isNotNull(exportJobs.s3Key)));

  const exportKeys = userExports
    .map((e) => {
      return e.s3Key;
    })
    .filter((k): k is string => {
      return k !== null;
    });

  if (exportKeys.length > 0) {
    try {
      await deleteS3Objects(bucket, exportKeys);
      log.debug("deleted export objects", { count: exportKeys.length });
    } catch (error) {
      log.error("failed to delete export objects (best-effort)", {
        userId,
        count: exportKeys.length,
        error,
      });
    }
  }

  log.info("user S3 data deleted", {
    userId,
    storageCount: userStorages.length,
    exportCount: exportKeys.length,
  });
}
