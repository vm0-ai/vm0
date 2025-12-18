/**
 * Content-addressable storage hash utilities
 * Computes SHA-256 hash of storage content for version identification
 */

import { createHash } from "crypto";

/**
 * File entry for hash computation
 */
export interface FileEntry {
  /** Relative path within the storage */
  path: string;
  /** File content as Buffer */
  content: Buffer;
}

/**
 * Compute SHA-256 hash of a single file's content
 */
export function hashFileContent(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Compute content-addressable hash for a collection of files
 *
 * The hash is computed using a merkle-tree-like approach:
 * 1. Include storage ID as prefix (to ensure uniqueness per storage)
 * 2. For each file, compute: "relativePath:sha256(content)"
 * 3. Sort all entries alphabetically by path
 * 4. Join with newlines
 * 5. Compute SHA-256 of the combined string
 *
 * This ensures:
 * - Same content in same storage produces same hash (deterministic)
 * - Same content in different storages produces different hashes
 * - Different content produces different hash
 * - File order doesn't affect the result (sorted)
 * - Both path and content contribute to the hash
 *
 * @param storageId The storage UUID to include in the hash
 * @param files Array of file entries with path and content
 * @returns 64-character lowercase hexadecimal SHA-256 hash
 */
export function computeContentHash(
  storageId: string,
  files: FileEntry[],
): string {
  // Handle empty storage case - still include storageId for uniqueness
  if (files.length === 0) {
    return createHash("sha256").update(`storage:${storageId}\n`).digest("hex");
  }

  // Create sorted list of "path:hash" entries
  const entries = files
    .map((file) => {
      const contentHash = hashFileContent(file.content);
      return `${file.path}:${contentHash}`;
    })
    .sort();

  // Include storageId prefix and combine with file entries
  const combined = `storage:${storageId}\n${entries.join("\n")}`;
  return createHash("sha256").update(combined).digest("hex");
}

/**
 * Minimum length for short version ID prefix
 */
export const MIN_VERSION_PREFIX_LENGTH = 8;

/**
 * Default display length for version IDs
 */
export const DEFAULT_VERSION_DISPLAY_LENGTH = 8;

/**
 * Full SHA-256 hash length
 */
export const FULL_VERSION_LENGTH = 64;

/**
 * Format a full version ID for display (short form)
 * @param versionId Full 64-character version ID
 * @returns 8-character short version ID
 */
export function formatShortVersion(versionId: string): string {
  return versionId.slice(0, DEFAULT_VERSION_DISPLAY_LENGTH);
}

/**
 * Check if a string is a valid SHA-256 hash (64 hex characters)
 */
export function isValidVersionId(versionId: string): boolean {
  return /^[a-f0-9]{64}$/i.test(versionId);
}

/**
 * Check if a string is a valid version prefix (8+ hex characters)
 */
export function isValidVersionPrefix(prefix: string): boolean {
  return (
    /^[a-f0-9]+$/i.test(prefix) && prefix.length >= MIN_VERSION_PREFIX_LENGTH
  );
}

/**
 * File entry with pre-computed hash (no content needed)
 * Used for direct upload flow where client computes hashes
 */
export interface FileEntryWithHash {
  /** Relative path within the storage */
  path: string;
  /** SHA-256 hash of file content (computed by client) */
  hash: string;
  /** File size in bytes */
  size: number;
}

/**
 * Compute content-addressable hash from file metadata only.
 *
 * This produces IDENTICAL hashes to computeContentHash() when given matching data,
 * because both use the same format: "storage:{storageId}\n{sorted path:hash entries}"
 *
 * Used in direct upload flow where the client has already computed file hashes,
 * so the server doesn't need to download file content.
 *
 * @param storageId The storage UUID to include in the hash
 * @param files Array of file entries with path and pre-computed hash
 * @returns 64-character lowercase hexadecimal SHA-256 hash
 */
export function computeContentHashFromHashes(
  storageId: string,
  files: FileEntryWithHash[],
): string {
  // Handle empty storage case - same as computeContentHash
  if (files.length === 0) {
    return createHash("sha256").update(`storage:${storageId}\n`).digest("hex");
  }

  // Create sorted list of "path:hash" entries - same format as computeContentHash
  const entries = files.map((file) => `${file.path}:${file.hash}`).sort();

  // Include storageId prefix and combine with file entries
  const combined = `storage:${storageId}\n${entries.join("\n")}`;
  return createHash("sha256").update(combined).digest("hex");
}
