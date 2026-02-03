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
 * Minimum length for short version ID prefix
 */
export const MIN_VERSION_PREFIX_LENGTH = 8;

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
interface FileEntryWithHash {
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
 * The hash is computed using a merkle-tree-like approach:
 * 1. Include storage ID as prefix (to ensure uniqueness per storage)
 * 2. For each file, use the pre-computed hash: "relativePath:hash"
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
  // Handle empty storage case - still include storageId for uniqueness
  if (files.length === 0) {
    return createHash("sha256").update(`storage:${storageId}\n`).digest("hex");
  }

  // Create sorted list of "path:hash" entries
  const entries = files.map((file) => `${file.path}:${file.hash}`).sort();

  // Include storageId prefix and combine with file entries
  const combined = `storage:${storageId}\n${entries.join("\n")}`;
  return createHash("sha256").update(combined).digest("hex");
}
