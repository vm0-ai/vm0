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
function hashFileContent(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Compute content-addressable hash for a collection of files
 *
 * The hash is computed using a merkle-tree-like approach:
 * 1. For each file, compute: "relativePath:sha256(content)"
 * 2. Sort all entries alphabetically by path
 * 3. Join with newlines
 * 4. Compute SHA-256 of the combined string
 *
 * This ensures:
 * - Same content always produces same hash (deterministic)
 * - Different content produces different hash
 * - File order doesn't affect the result (sorted)
 * - Both path and content contribute to the hash
 *
 * @param files Array of file entries with path and content
 * @returns 64-character lowercase hexadecimal SHA-256 hash
 */
export function computeContentHash(files: FileEntry[]): string {
  // Handle empty storage case
  if (files.length === 0) {
    // Hash of empty string for empty storage
    return createHash("sha256").update("").digest("hex");
  }

  // Create sorted list of "path:hash" entries
  const entries = files
    .map((file) => {
      const contentHash = hashFileContent(file.content);
      return `${file.path}:${contentHash}`;
    })
    .sort();

  // Combine and hash
  const combined = entries.join("\n");
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
