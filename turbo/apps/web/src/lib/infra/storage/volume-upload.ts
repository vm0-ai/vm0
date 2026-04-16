import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { eq, and } from "drizzle-orm";
import * as tar from "tar";
import { VOLUME_ORG_USER_ID } from "@vm0/core";
import { storages, storageVersions } from "../../../db/schema/storage";
import {
  putS3Object,
  listS3Objects,
  deleteS3Objects,
  verifyS3FilesExist,
} from "../s3/s3-client";
import type { S3StorageManifest } from "../s3/types";
import { computeContentHashFromHashes, hashFileContent } from "./content-hash";
import { env } from "../../../env";
import { logger } from "../../shared/logger";

const log = logger("storage:volume-upload");

/**
 * Upload a volume with multiple files to S3 from the server side.
 *
 * Creates a multi-file tar.gz archive from the provided files array,
 * computes content-addressable version hashes, and uploads to S3
 * with deduplication support.
 */
export async function uploadVolumeServerSide(params: {
  orgId: string;
  storageName: string;
  files: Array<{ path: string; content: string }>;
}): Promise<{ storageName: string; versionId: string }> {
  const { orgId, storageName, files } = params;

  // Compute per-file hashes and sizes
  const fileEntries = files.map((f) => {
    const buf = Buffer.from(f.content, "utf-8");
    return {
      path: f.path,
      content: buf,
      hash: hashFileContent(buf),
      size: buf.length,
    };
  });

  const totalSize = fileEntries.reduce((sum, f) => {
    return sum + f.size;
  }, 0);

  // Create multi-file tar.gz archive via temp directory
  const tmpDir = await mkdtemp(join(tmpdir(), "vm0-volume-"));

  try {
    // Write files preserving directory structure
    for (const file of fileEntries) {
      const filePath = resolve(join(tmpDir, file.path));
      if (!filePath.startsWith(tmpDir)) {
        throw new Error(`Invalid file path: ${file.path}`);
      }
      const dir = join(filePath, "..");
      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, file.content);
    }

    // Create tar.gz
    const tarPath = join(tmpDir, "__archive.tar.gz");
    await tar.create(
      { gzip: true, file: tarPath, cwd: tmpDir },
      fileEntries.map((f) => {
        return f.path;
      }),
    );

    const archiveBuffer = await readFile(tarPath);

    // Build manifest
    const fileHashEntries = fileEntries.map((f) => {
      return {
        path: f.path,
        hash: f.hash,
        size: f.size,
      };
    });

    // Upsert storage record
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

    // Compute version ID
    const versionId = computeContentHashFromHashes(storage.id, fileHashEntries);
    const s3Key = `${s3Prefix}/${versionId}`;
    const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;

    // Check for existing version (dedup)
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

    // Upload to S3
    const manifestKey = `${s3Key}/manifest.json`;
    const archiveKey = `${s3Key}/archive.tar.gz`;

    const manifest: S3StorageManifest = {
      version: versionId,
      createdAt: new Date().toISOString(),
      totalSize,
      fileCount: files.length,
      files: fileHashEntries,
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

    // Create version + update HEAD in transaction
    await db.transaction(async (tx) => {
      await tx
        .insert(storageVersions)
        .values({
          id: versionId,
          storageId: storage.id,
          s3Key,
          size: totalSize,
          fileCount: files.length,
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
          fileCount: files.length,
          updatedAt: new Date(),
        })
        .where(eq(storages.id, storage.id));
    });

    log.debug(
      `Uploaded volume ${storageName}: ${versionId} (${files.length} files)`,
    );
    return { storageName, versionId };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Delete a volume's storage from S3 and database.
 *
 * Removes storage versions, the storage record, and S3 objects.
 * Idempotent -- returns silently if the storage doesn't exist.
 */
export async function deleteVolumeServerSide(params: {
  orgId: string;
  storageName: string;
}): Promise<void> {
  const { orgId, storageName } = params;

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

  log.debug(`Deleted volume storage: ${storageName}`);
}
