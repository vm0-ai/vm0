import * as path from "path";
import * as zlib from "zlib";
import { Readable } from "stream";
import * as tar from "tar";
import { eq, and, lt, desc } from "drizzle-orm";
import { storages } from "../../db/schema/storage";
import { storageVersions } from "../../db/schema/storage";
import { downloadManifest, downloadS3Buffer } from "../s3/s3-client";
import type { S3StorageManifest } from "../s3/types";
import type { RunResult } from "../run/types";
import { env } from "../../env";
import { logger } from "../logger";

const log = logger("slack:artifact-files");

/**
 * File extensions considered valid for uploading to Slack.
 * Includes documents, images, archives, and common text formats.
 */
const VALID_EXTENSIONS = new Set([
  // Documents
  ".pdf",
  ".docx",
  ".pptx",
  ".xlsx",
  ".csv",
  // Images
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  // Archives
  ".zip",
  ".tgz",
  ".rar",
  ".7z",
  // Text formats
  ".txt",
  ".json",
  ".xml",
  ".html",
  ".md",
]);

/**
 * Check if a file path has a valid extension for Slack upload.
 * Handles compound extensions like `.tar.gz`.
 */
function hasValidExtension(filePath: string): boolean {
  if (filePath.endsWith(".tar.gz")) return true;
  const ext = path.extname(filePath).toLowerCase();
  return VALID_EXTENSIONS.has(ext);
}

interface ManifestFile {
  path: string;
  hash: string;
}

/**
 * Diff two manifests to find new or changed files.
 * Returns file paths that are new or have a different hash.
 */
export function diffManifests(
  current: S3StorageManifest,
  previous: S3StorageManifest | null,
): string[] {
  const previousMap = new Map<string, string>();
  if (previous) {
    for (const file of previous.files as ManifestFile[]) {
      previousMap.set(file.path, file.hash);
    }
  }

  const changedPaths: string[] = [];
  for (const file of current.files as ManifestFile[]) {
    const prevHash = previousMap.get(file.path);
    if (prevHash !== file.hash) {
      changedPaths.push(file.path);
    }
  }

  return changedPaths;
}

/**
 * Find the previous version of a storage (the one before the current version).
 */
async function findPreviousVersion(
  storageId: string,
  currentVersionCreatedAt: Date,
): Promise<{ s3Key: string } | null> {
  const [prev] = await globalThis.services.db
    .select({ s3Key: storageVersions.s3Key })
    .from(storageVersions)
    .where(
      and(
        eq(storageVersions.storageId, storageId),
        lt(storageVersions.createdAt, currentVersionCreatedAt),
      ),
    )
    .orderBy(desc(storageVersions.createdAt))
    .limit(1);

  return prev ?? null;
}

export interface ArtifactFile {
  filename: string;
  content: Buffer;
}

/**
 * Extract specific files from a tar.gz buffer.
 * Uses streaming parsing to avoid loading unwanted files into memory.
 */
export async function extractFilesFromArchive(
  archiveBuffer: Buffer,
  targetPaths: Set<string>,
): Promise<ArtifactFile[]> {
  const files: ArtifactFile[] = [];

  return new Promise((resolve, reject) => {
    const parser = new tar.Parser({
      filter: (entryPath) => targetPaths.has(entryPath),
      onReadEntry: (entry) => {
        const chunks: Buffer[] = [];
        entry.on("data", (chunk: Buffer) => chunks.push(chunk));
        entry.on("end", () => {
          files.push({
            filename: path.basename(entry.path),
            content: Buffer.concat(chunks),
          });
        });
      },
    });

    parser.on("end", () => resolve(files));
    parser.on("error", reject);

    const gunzip = zlib.createGunzip();
    gunzip.on("error", reject);

    Readable.from(archiveBuffer).pipe(gunzip).pipe(parser);
  });
}

/**
 * Get new/changed artifact files from a completed run.
 *
 * Compares the current artifact version manifest with the previous version
 * to identify new or changed files, filters by valid file types, and
 * extracts them from the tar.gz archive.
 *
 * Returns an empty array if:
 * - The run has no artifact
 * - No files changed
 * - No changed files match valid extensions
 */
export async function getNewArtifactFiles(
  runResult: RunResult,
  userId: string,
  clerkOrgId: string,
): Promise<ArtifactFile[]> {
  if (!runResult.artifact) return [];

  const artifactEntries = Object.entries(runResult.artifact);
  if (artifactEntries.length === 0) return [];

  const [artifactName, artifactVersion] = artifactEntries[0]!;

  // Look up storage record
  const [storage] = await globalThis.services.db
    .select()
    .from(storages)
    .where(
      and(
        eq(storages.clerkOrgId, clerkOrgId),
        eq(storages.userId, userId),
        eq(storages.name, artifactName),
        eq(storages.type, "artifact"),
      ),
    )
    .limit(1);

  if (!storage) {
    log.debug("Storage not found for artifact", { artifactName, userId });
    return [];
  }

  // Look up current version
  const [currentVersion] = await globalThis.services.db
    .select({
      s3Key: storageVersions.s3Key,
      createdAt: storageVersions.createdAt,
    })
    .from(storageVersions)
    .where(eq(storageVersions.id, artifactVersion))
    .limit(1);

  if (!currentVersion) {
    log.debug("Current version not found", { artifactVersion });
    return [];
  }

  const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;

  // Download current manifest
  const currentManifest = await downloadManifest(
    bucketName,
    currentVersion.s3Key,
  );

  // Find and download previous manifest (null if first run)
  const prevVersion = await findPreviousVersion(
    storage.id,
    currentVersion.createdAt,
  );
  const previousManifest = prevVersion
    ? await downloadManifest(bucketName, prevVersion.s3Key)
    : null;

  // Diff manifests and filter by valid extensions
  const changedPaths = diffManifests(currentManifest, previousManifest);
  const validPaths = changedPaths.filter(hasValidExtension);

  if (validPaths.length === 0) return [];

  // Download archive and extract matching files
  const archiveKey = `${currentVersion.s3Key}/archive.tar.gz`;
  const archiveBuffer = await downloadS3Buffer(bucketName, archiveKey);

  return extractFilesFromArchive(archiveBuffer, new Set(validPaths));
}
