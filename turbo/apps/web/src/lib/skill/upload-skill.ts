/**
 * Orchestrates downloading a skill from GitHub and uploading it to S3 + DB.
 *
 * Follows the same pattern as the instructions PUT endpoint:
 * 1. Find or create a storage record
 * 2. Compute content-addressable version ID
 * 3. Upload archive + manifest to S3 (idempotent)
 * 4. Create version + update HEAD in a DB transaction
 */

import { gzipSync } from "node:zlib";
import { eq, and } from "drizzle-orm";
import { parseGitHubTreeUrl, getSkillStorageName } from "@vm0/core";
import { storages, storageVersions } from "../../db/schema/storage";
import {
  hashFileContent,
  computeContentHashFromHashes,
} from "../storage/content-hash";
import { putS3Object } from "../s3/s3-client";
import type { S3StorageManifest } from "../s3/types";
import { env } from "../../env";
import { createMultiFileTar } from "../tar";
import { downloadSkillFromGitHub } from "../github/download-skill";

interface UploadSkillContext {
  userId: string;
  scopeId: string;
  scopeSlug: string;
}

/**
 * Download a skill from GitHub and upload it to storage.
 *
 * Deduplication:
 * - If a storage with a HEAD version already exists, skip entirely.
 * - If the computed version already exists in S3, skip the upload.
 *
 * @param skillUrl - Resolved GitHub tree URL (already normalized by caller)
 * @param ctx - User/scope context for DB records
 */
export async function uploadSkillFromGitHub(
  skillUrl: string,
  ctx: UploadSkillContext,
): Promise<void> {
  const parsed = parseGitHubTreeUrl(skillUrl);
  if (!parsed) {
    throw new Error(
      `Invalid skill URL: ${skillUrl}. Expected format: https://github.com/{owner}/{repo}/tree/{branch}/{path}`,
    );
  }

  const storageName = getSkillStorageName(parsed.fullPath);

  // Check if storage already exists with a HEAD version (already uploaded)
  const [existing] = await globalThis.services.db
    .select({ id: storages.id, headVersionId: storages.headVersionId })
    .from(storages)
    .where(
      and(
        eq(storages.scopeId, ctx.scopeId),
        eq(storages.name, storageName),
        eq(storages.type, "volume"),
      ),
    )
    .limit(1);

  if (existing?.headVersionId) {
    return; // Already uploaded, skip
  }

  // Download skill files from GitHub
  const downloadedFiles = await downloadSkillFromGitHub(parsed);

  // Compute file hashes
  const fileHashes = downloadedFiles.map((f) => ({
    path: f.path,
    hash: hashFileContent(f.content),
    size: f.content.length,
  }));

  // Find or create storage record
  let storageRecord = existing ? { id: existing.id } : null;

  if (!storageRecord) {
    const [created] = await globalThis.services.db
      .insert(storages)
      .values({
        userId: ctx.userId,
        scopeId: ctx.scopeId,
        name: storageName,
        type: "volume",
        s3Prefix: `${ctx.scopeSlug}/volume/${storageName}`,
        size: 0,
        fileCount: 0,
      })
      .returning({ id: storages.id });

    if (!created) {
      throw new Error(`Failed to create storage for skill: ${storageName}`);
    }
    storageRecord = created;
  }

  const versionId = computeContentHashFromHashes(storageRecord.id, fileHashes);
  const s3Key = `${ctx.scopeSlug}/volume/${storageName}/${versionId}`;
  const bucket = env().R2_USER_STORAGES_BUCKET_NAME;

  const totalSize = fileHashes.reduce((sum, f) => sum + f.size, 0);
  const manifest: S3StorageManifest = {
    version: versionId,
    createdAt: new Date().toISOString(),
    totalSize,
    fileCount: fileHashes.length,
    files: fileHashes,
  };

  const tarBuffer = createMultiFileTar(
    downloadedFiles.map((f) => ({ path: f.path, content: f.content })),
  );
  const archiveBuffer = gzipSync(tarBuffer);

  // Upload to S3 (idempotent — content-addressable keys)
  await Promise.all([
    putS3Object(
      bucket,
      `${s3Key}/manifest.json`,
      JSON.stringify(manifest),
      "application/json",
    ),
    putS3Object(
      bucket,
      `${s3Key}/archive.tar.gz`,
      archiveBuffer,
      "application/gzip",
    ),
  ]);

  // DB transaction: create version + update HEAD pointer
  await globalThis.services.db.transaction(async (tx) => {
    await tx
      .insert(storageVersions)
      .values({
        id: versionId,
        storageId: storageRecord.id,
        s3Key,
        size: totalSize,
        fileCount: fileHashes.length,
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
        fileCount: fileHashes.length,
        updatedAt: new Date(),
      })
      .where(eq(storages.id, storageRecord.id));
  });
}
