/**
 * Session History Module
 * Manages storage and retrieval of CLI agent session history (JSONL)
 * using R2 blob storage for scalability.
 */

import { downloadBlob } from "../blob/blob-service";
import { blobs } from "@vm0/db/schema/blob";
import { sql } from "drizzle-orm";
import { logger } from "../../shared/logger";

const log = logger("session-history");

/**
 * Pre-register a session history blob with correct size before S3 upload.
 * Creates the blob record with refCount 0; the subsequent checkpoint call
 * will increment refCount via registerSessionHistoryBlob.
 *
 * On conflict (blob already exists), updates size to the correct value.
 *
 * @param hash SHA-256 hash of the content
 * @param size File size in bytes
 */
export async function preRegisterSessionHistoryBlob(
  hash: string,
  size: number,
): Promise<void> {
  log.debug(`Pre-registering session history blob, hash=${hash}, size=${size}`);

  await globalThis.services.db
    .insert(blobs)
    .values({ hash, size, refCount: 0 })
    .onConflictDoUpdate({
      target: blobs.hash,
      set: { size },
    });
}

/**
 * Register a session history blob that was uploaded directly to S3 via presigned URL.
 * The blob record (with correct size) is pre-created by the prepare-history endpoint;
 * this function increments refCount to track usage.
 *
 * Note: The guest-agent flow is sequential: prepare-history → S3 upload → checkpoint.
 * The blob record and S3 object are guaranteed to exist before this is called.
 *
 * @param hash SHA-256 hash of the content (already verified by the caller)
 * @returns The hash
 */
export async function registerSessionHistoryBlob(
  hash: string,
): Promise<string> {
  log.debug(`Registering session history blob, hash=${hash}`);

  await globalThis.services.db
    .insert(blobs)
    .values({ hash, size: 0, refCount: 1 })
    .onConflictDoUpdate({
      target: blobs.hash,
      set: { refCount: sql`${blobs.refCount} + 1` },
    });

  return hash;
}

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
