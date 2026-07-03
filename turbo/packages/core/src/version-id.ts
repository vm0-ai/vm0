/**
 * Version ID utilities for image versioning
 *
 * Version IDs are SHA-256 hashes (64 hex characters) stored in the database,
 * but displayed in a shortened form (8 characters) for user-friendliness.
 * Matches artifact/storage version display for consistency.
 * Similar to Docker image digests and Git commit hashes.
 */

/**
 * Full length of version ID (SHA-256 hex)
 */
export const VERSION_ID_LENGTH = 64;

/**
 * Display length of version ID (first N characters)
 * Matches artifact/storage display length for consistency
 */
export const VERSION_ID_DISPLAY_LENGTH = 8;

/**
 * Minimum prefix length for version ID matching
 * Matches artifact/storage prefix length for consistency
 */
export const MIN_VERSION_PREFIX_LENGTH = 8;

/**
 * Format a version ID for display (first 8 characters)
 *
 * @param versionId - Full 64-character version ID
 * @returns Truncated version ID for display
 */
export function formatVersionIdForDisplay(versionId: string): string {
  return versionId.slice(0, VERSION_ID_DISPLAY_LENGTH);
}

/**
 * Check if a string is a valid version ID prefix
 *
 * @param prefix - String to check
 * @returns True if valid hex prefix of sufficient length
 */
export function isValidVersionPrefix(prefix: string): boolean {
  return (
    /^[a-f0-9]+$/i.test(prefix) && prefix.length >= MIN_VERSION_PREFIX_LENGTH
  );
}
