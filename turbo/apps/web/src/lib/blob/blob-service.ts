/**
 * Blob Service
 * Manages content-addressable blob storage with deduplication
 */

import { eq, inArray, sql } from "drizzle-orm";
import { blobs } from "../../db/schema/blob";
import {
  uploadS3Buffer,
  deleteS3Objects,
  downloadBlob as downloadBlobFromS3,
} from "../s3/s3-client";
import { hashFileContent, type FileEntry } from "../storage/content-hash";
import { env } from "../../env";
import { logger } from "../logger";
import pLimit from "p-limit";

const log = logger("service:blob");

/** Maximum concurrent S3 uploads */
const MAX_CONCURRENT_UPLOADS = 10;

/**
 * Result of uploading blobs
 */
interface BlobUploadResult {
  /** Map of file path to blob hash */
  hashes: Map<string, string>;
  /** Number of new blobs uploaded */
  newBlobsCount: number;
  /** Number of existing blobs (deduplicated) */
  existingBlobsCount: number;
  /** Total bytes uploaded (new blobs only) */
  bytesUploaded: number;
}

/**
 * Blob Service class
 * Handles blob upload with deduplication
 */
class BlobService {
  /**
   * Upload file entries as blobs with deduplication
   *
   * 1. Compute hash for each file
   * 2. Query database for existing blobs
   * 3. Upload only new blobs to S3
   * 4. Insert new blob records, increment ref_count for existing
   *
   * @param files Array of file entries to upload
   * @returns Upload result with hash mapping
   */
  async uploadBlobs(files: FileEntry[]): Promise<BlobUploadResult> {
    if (files.length === 0) {
      return {
        hashes: new Map(),
        newBlobsCount: 0,
        existingBlobsCount: 0,
        bytesUploaded: 0,
      };
    }

    const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;

    // Step 1: Compute hashes for all files
    const fileHashes = new Map<string, { hash: string; content: Buffer }>();
    const hashToFiles = new Map<string, FileEntry[]>();

    for (const file of files) {
      const hash = hashFileContent(file.content);
      fileHashes.set(file.path, { hash, content: file.content });

      // Group files by hash (multiple files can have same content)
      const existing = hashToFiles.get(hash) || [];
      existing.push(file);
      hashToFiles.set(hash, existing);
    }

    const uniqueHashes = Array.from(hashToFiles.keys());
    log.debug(
      `Processing ${files.length} files with ${uniqueHashes.length} unique hashes`,
    );

    // Step 2: Query database for existing blobs
    const existingBlobs = await globalThis.services.db
      .select({ hash: blobs.hash })
      .from(blobs)
      .where(inArray(blobs.hash, uniqueHashes));

    const existingHashSet = new Set(existingBlobs.map((b) => b.hash));
    const newHashes = uniqueHashes.filter((h) => !existingHashSet.has(h));

    log.debug(
      `Found ${existingHashSet.size} existing blobs, ${newHashes.length} new blobs`,
    );

    // Step 3: Upload new blobs to S3 with concurrency limit
    const limit = pLimit(MAX_CONCURRENT_UPLOADS);
    let bytesUploaded = 0;
    const uploadedS3Keys: string[] = [];

    const uploadPromises = newHashes.map((hash) =>
      limit(async () => {
        const file = hashToFiles.get(hash)![0]!;
        const s3Key = `blobs/${hash}.blob`;
        await uploadS3Buffer(bucketName, s3Key, file.content);
        uploadedS3Keys.push(s3Key);
        bytesUploaded += file.content.length;
      }),
    );

    await Promise.all(uploadPromises);

    // Step 4: Database operations with rollback on failure
    // Use ON CONFLICT to handle race conditions where another request
    // may have inserted the same blob concurrently
    try {
      if (newHashes.length > 0) {
        const newBlobRecords = newHashes.map((hash) => {
          const file = hashToFiles.get(hash)![0]!;
          return {
            hash,
            size: file.content.length,
            refCount: 1,
          };
        });

        // Use ON CONFLICT DO UPDATE to handle race condition
        // If blob already exists, increment ref_count instead of failing
        await globalThis.services.db
          .insert(blobs)
          .values(newBlobRecords)
          .onConflictDoUpdate({
            target: blobs.hash,
            set: { refCount: sql`${blobs.refCount} + 1` },
          });
      }

      if (existingHashSet.size > 0) {
        await globalThis.services.db
          .update(blobs)
          .set({ refCount: sql`${blobs.refCount} + 1` })
          .where(inArray(blobs.hash, Array.from(existingHashSet)));
      }
    } catch (dbError) {
      // Rollback: delete uploaded S3 objects on database failure
      log.error("Database operation failed, rolling back S3 uploads", dbError);
      try {
        await deleteS3Objects(bucketName, uploadedS3Keys);
        log.debug(`Rolled back ${uploadedS3Keys.length} S3 objects`);
      } catch (rollbackError) {
        log.error("Failed to rollback S3 uploads", rollbackError);
      }
      throw dbError;
    }

    // Build result hash map
    const hashes = new Map<string, string>();
    for (const [path, { hash }] of fileHashes) {
      hashes.set(path, hash);
    }

    log.debug(
      `Blob upload complete: ${newHashes.length} new, ${existingHashSet.size} existing, ${bytesUploaded} bytes uploaded`,
    );

    return {
      hashes,
      newBlobsCount: newHashes.length,
      existingBlobsCount: existingHashSet.size,
      bytesUploaded,
    };
  }

  /**
   * Decrement ref_count for blobs referenced by a storage version
   * Called when deleting a storage version
   *
   * @param blobHashes Array of blob hashes to decrement
   */
  async decrementRefCounts(blobHashes: string[]): Promise<void> {
    if (blobHashes.length === 0) return;

    await globalThis.services.db
      .update(blobs)
      .set({ refCount: sql`${blobs.refCount} - 1` })
      .where(inArray(blobs.hash, blobHashes));

    log.debug(`Decremented ref_count for ${blobHashes.length} blobs`);
  }

  /**
   * Check if a blob exists by hash
   *
   * @param hash SHA-256 hash to check
   * @returns true if blob exists
   */
  async exists(hash: string): Promise<boolean> {
    const [result] = await globalThis.services.db
      .select({ hash: blobs.hash })
      .from(blobs)
      .where(eq(blobs.hash, hash))
      .limit(1);

    return !!result;
  }

  /**
   * Download a single blob by hash
   *
   * @param hash SHA-256 hash of the blob
   * @returns Blob content as Buffer
   */
  async downloadBlob(hash: string): Promise<Buffer> {
    const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;
    return downloadBlobFromS3(bucketName, hash);
  }

  /**
   * Download multiple blobs by hash
   * Uses concurrency limit to avoid overwhelming S3
   *
   * @param hashes Array of SHA-256 hashes
   * @returns Map of hash to blob content
   */
  async downloadBlobs(hashes: string[]): Promise<Map<string, Buffer>> {
    if (hashes.length === 0) {
      return new Map();
    }

    const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;
    const result = new Map<string, Buffer>();
    const uniqueHashes = [...new Set(hashes)];
    const limit = pLimit(MAX_CONCURRENT_UPLOADS);

    await Promise.all(
      uniqueHashes.map((hash) =>
        limit(async () => {
          const content = await downloadBlobFromS3(bucketName, hash);
          result.set(hash, content);
        }),
      ),
    );

    log.debug(`Downloaded ${result.size} blobs`);
    return result;
  }
}

// Export singleton instance
export const blobService = new BlobService();
