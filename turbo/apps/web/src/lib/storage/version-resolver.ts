/**
 * Version resolution utilities for storage versions
 * Supports exact match and short prefix matching (like Git)
 */

import { storageVersions } from "../../db/schema/storage";
import { eq, and, like } from "drizzle-orm";
import {
  isValidVersionPrefix,
  MIN_VERSION_PREFIX_LENGTH,
} from "./content-hash";

/**
 * Storage version record type
 */
export type StorageVersion = typeof storageVersions.$inferSelect;

/**
 * Result of version resolution - either success with version or error with details
 */
export type VersionResolutionResult =
  | { version: StorageVersion }
  | { error: string; status: number };

/**
 * Resolve a version by ID or prefix within a storage
 *
 * Resolution order:
 * 1. Try exact match (full 64-char hash)
 * 2. Try prefix match (minimum 8 characters)
 *
 * @param storageId - UUID of the storage
 * @param versionIdOrPrefix - Full version ID or short prefix (8+ chars)
 * @returns Resolved version or error with HTTP status code
 */
export async function resolveVersionByPrefix(
  storageId: string,
  versionIdOrPrefix: string,
): Promise<VersionResolutionResult> {
  // First, try exact match
  const [exactMatch] = await globalThis.services.db
    .select()
    .from(storageVersions)
    .where(
      and(
        eq(storageVersions.storageId, storageId),
        eq(storageVersions.id, versionIdOrPrefix),
      ),
    )
    .limit(1);

  if (exactMatch) {
    return { version: exactMatch };
  }

  // If not exact match, try prefix match (for short version IDs)
  if (!isValidVersionPrefix(versionIdOrPrefix)) {
    // Too short or invalid format
    if (versionIdOrPrefix.length < MIN_VERSION_PREFIX_LENGTH) {
      return {
        error: `Version prefix too short. Minimum ${MIN_VERSION_PREFIX_LENGTH} characters required.`,
        status: 400,
      };
    }
    return {
      error: `Version "${versionIdOrPrefix}" not found`,
      status: 404,
    };
  }

  // Search by prefix using LIKE
  const prefixMatches = await globalThis.services.db
    .select()
    .from(storageVersions)
    .where(
      and(
        eq(storageVersions.storageId, storageId),
        like(storageVersions.id, `${versionIdOrPrefix.toLowerCase()}%`),
      ),
    )
    .limit(2); // Only need to know if there's more than one

  if (prefixMatches.length === 0) {
    return {
      error: `Version "${versionIdOrPrefix}" not found`,
      status: 404,
    };
  }

  if (prefixMatches.length > 1) {
    return {
      error: `Ambiguous version prefix "${versionIdOrPrefix}". Please use more characters.`,
      status: 400,
    };
  }

  const matchedVersion = prefixMatches[0];
  if (!matchedVersion) {
    return {
      error: `Version "${versionIdOrPrefix}" not found`,
      status: 404,
    };
  }

  return { version: matchedVersion };
}

/**
 * Check if a resolution result is an error
 */
export function isResolutionError(
  result: VersionResolutionResult,
): result is { error: string; status: number } {
  return "error" in result;
}
