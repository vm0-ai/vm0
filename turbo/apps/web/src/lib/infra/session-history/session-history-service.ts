/**
 * Session History Module
 * Manages storage and retrieval of CLI agent session history (JSONL)
 * using R2 blob storage for scalability.
 */

import { downloadBlob } from "../blob/blob-service";
import { logger } from "../../shared/logger";

const log = logger("session-history");

/**
 * Retrieve session history content from R2 blob storage
 *
 * @param hash SHA-256 hash of the content
 * @returns JSONL session history content
 */
async function retrieveSessionHistory(hash: string): Promise<string> {
  log.debug(`Retrieving session history, hash=${hash}`);

  const buffer = await downloadBlob(hash);
  return buffer.toString("utf-8");
}

/**
 * Resolve session history from hash (R2) or legacy TEXT field
 * Prioritizes hash if available for new records
 * Falls back to legacy TEXT if R2 retrieval fails
 *
 * @param hash SHA-256 hash reference (new records)
 * @param legacyText Legacy TEXT field content (old records)
 * @returns Session history content, or null if neither available
 */
export async function resolveSessionHistory(
  hash: string | null,
  legacyText: string | null,
): Promise<string | null> {
  if (hash) {
    log.debug(`Resolving session history from R2, hash=${hash}`);
    try {
      return await retrieveSessionHistory(hash);
    } catch (error) {
      // Fallback to legacy TEXT if R2 retrieval fails
      if (legacyText) {
        log.warn(
          `R2 retrieval failed for hash=${hash}, falling back to legacy TEXT`,
          { error },
        );
        return legacyText;
      }
      // No fallback available, re-throw the error
      throw error;
    }
  }

  if (legacyText) {
    log.debug("Resolving session history from legacy TEXT field");
    return legacyText;
  }

  return null;
}
