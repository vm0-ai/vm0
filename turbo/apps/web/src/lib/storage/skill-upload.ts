import { eq, and } from "drizzle-orm";
import { getCustomSkillStorageName, VOLUME_ORG_USER_ID } from "@vm0/core";
import { storages, storageVersions } from "../../db/schema/storage";
import { listS3Objects, deleteS3Objects } from "../s3/s3-client";
import { env } from "../../env";
import { logger } from "../logger";
import { uploadStorageServerSide } from "./upload-storage";

const log = logger("storage:skill-upload");

const SKILL_FILENAME = "SKILL.md";

/**
 * Upload a custom skill directly to S3 from the server side.
 *
 * Bypasses the CLI's prepare -> presigned URL -> commit flow by writing
 * archive.tar.gz and manifest.json directly via putS3Object().
 * Delegates to the shared uploadStorageServerSide for the core upload logic.
 */
export async function uploadSkillServerSide(params: {
  orgId: string;
  skillName: string;
  content: string;
}): Promise<{ storageName: string; versionId: string }> {
  const { orgId, skillName, content } = params;

  const storageName = getCustomSkillStorageName(skillName);

  const result = await uploadStorageServerSide({
    orgId,
    storageName,
    filename: SKILL_FILENAME,
    content,
    log,
  });

  log.debug(`Uploaded skill ${skillName}: ${result.versionId}`);
  return result;
}

/**
 * Delete a custom skill's storage from S3 and database.
 *
 * Removes storage versions, the storage record, and S3 objects.
 * Idempotent -- returns silently if the storage doesn't exist.
 */
export async function deleteSkillServerSide(params: {
  orgId: string;
  skillName: string;
}): Promise<void> {
  const { orgId, skillName } = params;

  const storageName = getCustomSkillStorageName(skillName);
  const db = globalThis.services.db;

  // 1. Look up storage by name + orgId
  const [storage] = await db
    .select()
    .from(storages)
    .where(
      and(
        eq(storages.orgId, orgId),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, storageName),
        eq(storages.type, "volume"),
      ),
    )
    .limit(1);

  if (!storage) {
    return; // Idempotent -- nothing to delete
  }

  // 2. S3 cleanup first so DB records remain trackable on failure
  const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;
  const objects = await listS3Objects(bucketName, storage.s3Prefix);
  if (objects.length > 0) {
    await deleteS3Objects(
      bucketName,
      objects.map((o) => {
        return o.key;
      }),
    );
  }

  // 3. Delete DB records after successful S3 cleanup
  //    Clear headVersionId first to avoid FK violation (storages.headVersionId → storageVersions.id)
  await db
    .update(storages)
    .set({ headVersionId: null })
    .where(eq(storages.id, storage.id));

  await db
    .delete(storageVersions)
    .where(eq(storageVersions.storageId, storage.id));

  await db.delete(storages).where(eq(storages.id, storage.id));

  log.debug(`Deleted skill storage: ${storageName}`);
}
