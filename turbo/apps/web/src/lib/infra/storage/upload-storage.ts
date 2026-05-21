import { gzipSync } from "node:zlib";
import { eq, and } from "drizzle-orm";
import { VOLUME_ORG_USER_ID } from "@vm0/core/storage-names";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { putS3Object, verifyS3FilesExist } from "../s3/s3-client";
import type { S3StorageManifest } from "../s3/types";
import {
  computeContentHashFromHashes,
  hashFileContent,
  type FileEntryWithHash,
} from "./content-hash";
import { createTarArchive } from "../tar";
import { env } from "../../../env";

interface LogMethods {
  debug: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

interface UploadStorageFile {
  filename: string;
  content: string;
}

type UploadStorageServerSideParams = {
  orgId: string;
  storageName: string;
  log: LogMethods;
} & (
  | {
      filename: string;
      content: string;
      files?: never;
    }
  | {
      filename?: never;
      content?: never;
      files: UploadStorageFile[];
    }
);

/**
 * Shared server-side storage upload logic.
 *
 * Handles the full flow: tar.gz creation, storage upsert,
 * dedup check, S3 upload, and version+HEAD transaction.
 *
 * Used by instruction-upload.
 */
export async function uploadStorageServerSide(
  params: UploadStorageServerSideParams,
): Promise<{ storageName: string; versionId: string }> {
  const { orgId, storageName, log } = params;
  const files: UploadStorageFile[] =
    params.files !== undefined
      ? params.files
      : [{ filename: params.filename, content: params.content }];

  // 1. Create tar.gz archive
  const storageFiles = files.map((file) => {
    return {
      filename: file.filename,
      content: Buffer.from(file.content, "utf-8"),
    };
  });
  const tarBuffer = createTarArchive(storageFiles);
  const archiveBuffer = gzipSync(tarBuffer);

  // 3. Compute file hash and content hash
  const fileEntries: FileEntryWithHash[] = storageFiles.map((file) => {
    return {
      path: file.filename,
      hash: hashFileContent(file.content),
      size: file.content.length,
    };
  });
  const totalSize = fileEntries.reduce((sum, file) => {
    return sum + file.size;
  }, 0);

  // 4. Upsert storage record
  const db = globalThis.services.db;
  const storageType = "volume";
  const s3Prefix = `${orgId}/${storageType}/${storageName}`;

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

  // 5. Compute version ID
  const versionId = computeContentHashFromHashes(storage.id, fileEntries);
  const s3Key = `${s3Prefix}/${versionId}`;
  const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;

  // 6. Check for existing version (dedup)
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

  // 7. Upload to S3
  const manifestKey = `${s3Key}/manifest.json`;
  const archiveKey = `${s3Key}/archive.tar.gz`;

  const manifest: S3StorageManifest = {
    version: versionId,
    createdAt: new Date().toISOString(),
    totalSize,
    fileCount: fileEntries.length,
    files: fileEntries,
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

  // 8. Create version + update HEAD in transaction
  await db.transaction(async (tx) => {
    await tx
      .insert(storageVersions)
      .values({
        id: versionId,
        storageId: storage.id,
        s3Key,
        size: totalSize,
        fileCount: fileEntries.length,
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
        size: totalSize,
        fileCount: fileEntries.length,
        updatedAt: new Date(),
      })
      .where(eq(storages.id, storage.id));
  });

  return { storageName, versionId };
}
