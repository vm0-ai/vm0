import { gzipSync } from "node:zlib";
import { eq, and } from "drizzle-orm";
import {
  getInstructionsFilename,
  getInstructionsStorageName,
  VOLUME_ORG_USER_ID,
} from "@vm0/core";
import { storages, storageVersions } from "../../db/schema/storage";
import { putS3Object, verifyS3FilesExist } from "../s3/s3-client";
import type { S3StorageManifest } from "../s3/types";
import { computeContentHashFromHashes, hashFileContent } from "./content-hash";
import { createSingleFileTar } from "../tar";
import { env } from "../../env";
import { getOrgData } from "../org/org-cache-service";
import { logger } from "../logger";

const log = logger("storage:instruction-upload");

/**
 * Upload instructions directly to S3 from the server side.
 *
 * Bypasses the CLI's prepare → presigned URL → commit flow by writing
 * archive.tar.gz and manifest.json directly via putS3Object().
 * Used by server-side compose to upload instructions without a sandbox.
 */
export async function uploadInstructionsServerSide(params: {
  orgId: string;
  agentName: string;
  content: string;
  framework?: string;
}): Promise<{ storageName: string; versionId: string }> {
  const { orgId, agentName, content, framework } = params;

  // 1. Resolve org slug for S3 prefix
  const orgData = await getOrgData(orgId);
  const orgSlug = orgData.slug;

  // 2. Determine filename and storage name
  const filename = getInstructionsFilename(framework);
  const storageName = getInstructionsStorageName(agentName.toLowerCase());

  // 3. Create tar.gz archive
  const contentBuffer = Buffer.from(content, "utf-8");
  const tarBuffer = createSingleFileTar(filename, contentBuffer);
  const archiveBuffer = gzipSync(tarBuffer);

  // 5. Compute file hash and content hash
  const fileHash = hashFileContent(contentBuffer);
  const fileSize = contentBuffer.length;
  const fileEntry = { path: filename, hash: fileHash, size: fileSize };

  // 6. Upsert storage record
  const db = globalThis.services.db;
  const storageType = "volume";
  const s3Prefix = `${orgSlug}/${storageType}/${storageName}`;

  const [storage] = await db
    .insert(storages)
    .values({
      userId: VOLUME_ORG_USER_ID,
      orgId,
      name: storageName,
      type: storageType,
      s3Prefix,
      size: 0,
      fileCount: 0,
    })
    .onConflictDoUpdate({
      target: [storages.orgId, storages.userId, storages.name, storages.type],
      set: { updatedAt: new Date() },
    })
    .returning();

  if (!storage) {
    throw new Error(`Failed to create storage for ${storageName}`);
  }

  // 7. Compute version ID
  const versionId = computeContentHashFromHashes(storage.id, [fileEntry]);
  const s3Key = `${s3Prefix}/${versionId}`;
  const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;

  // 8. Check for existing version (dedup)
  const [existingVersion] = await db
    .select()
    .from(storageVersions)
    .where(
      and(
        eq(storageVersions.storageId, storage.id),
        eq(storageVersions.id, versionId),
      ),
    )
    .limit(1);

  if (existingVersion) {
    const s3Exists = await verifyS3FilesExist(
      bucketName,
      existingVersion.s3Key,
      existingVersion.fileCount,
    );

    if (s3Exists) {
      log.debug(`Version ${versionId} already exists, updating HEAD`);
      if (storage.headVersionId !== versionId) {
        await db
          .update(storages)
          .set({ headVersionId: versionId, updatedAt: new Date() })
          .where(eq(storages.id, storage.id));
      }
      return { storageName, versionId };
    }
    log.warn(`Version ${versionId} in DB but S3 files missing, re-uploading`);
  }

  // 9. Upload to S3
  const manifestKey = `${s3Key}/manifest.json`;
  const archiveKey = `${s3Key}/archive.tar.gz`;

  const manifest: S3StorageManifest = {
    version: versionId,
    createdAt: new Date().toISOString(),
    totalSize: fileSize,
    fileCount: 1,
    files: [fileEntry],
  };

  await Promise.all([
    putS3Object(bucketName, archiveKey, archiveBuffer, "application/gzip"),
    putS3Object(
      bucketName,
      manifestKey,
      JSON.stringify(manifest),
      "application/json",
    ),
  ]);

  // 10. Create version + update HEAD in transaction
  await db.transaction(async (tx) => {
    await tx
      .insert(storageVersions)
      .values({
        id: versionId,
        storageId: storage.id,
        s3Key,
        size: fileSize,
        fileCount: 1,
        message: null,
        createdBy: "user",
      })
      .onConflictDoNothing();

    const [version] = await tx
      .select({ id: storageVersions.id })
      .from(storageVersions)
      .where(eq(storageVersions.id, versionId))
      .limit(1);

    if (!version) {
      throw new Error(`Version ${versionId} not found after insert`);
    }

    await tx
      .update(storages)
      .set({
        headVersionId: versionId,
        size: fileSize,
        fileCount: 1,
        updatedAt: new Date(),
      })
      .where(eq(storages.id, storage.id));
  });

  log.debug(`Uploaded instructions for ${agentName}: ${versionId}`);
  return { storageName, versionId };
}
