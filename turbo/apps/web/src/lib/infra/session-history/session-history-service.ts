/**
 * Session History Module
 * Manages storage and retrieval of CLI agent session history (JSONL)
 * using R2 blob storage for scalability.
 */

import { downloadBlob } from "../blob/blob-service";
import { blobs } from "@vm0/db/schema/blob";
import { eq, sql } from "drizzle-orm";
import { logger } from "../../shared/logger";
import type { Database } from "../../../types/global";

const log = logger("session-history");

/**
 * Register a session history blob that was uploaded directly to S3 via presigned URL.
 * The checkpoint webhook calls this only when a conversation claims the
 * uploaded content, so abnormal exits do not leave refCount=0 DB rows behind.
 *
 * Note: The guest-agent flow is sequential: prepare-history → S3 upload → checkpoint.
 * The S3 object is guaranteed to exist before this is called.
 *
 * @param hash SHA-256 hash of the content (already verified by the caller)
 * @param size File size in bytes. Older callers may omit it; existing non-zero
 * sizes are preserved when size is 0.
 * @returns The hash
 */
async function registerSessionHistoryBlob(
  hash: string,
  size: number = 0,
  db: Pick<Database, "insert"> = globalThis.services.db,
): Promise<string> {
  log.debug(`Registering session history blob, hash=${hash}`);

  await db
    .insert(blobs)
    .values({ hash, size, refCount: 1 })
    .onConflictDoUpdate({
      target: blobs.hash,
      set: {
        size:
          size > 0
            ? sql`CASE WHEN ${blobs.size} = 0 THEN ${size} ELSE ${blobs.size} END`
            : sql`${blobs.size}`,
        refCount: sql`${blobs.refCount} + 1`,
      },
    });

  return hash;
}

/**
 * Move one conversation's session-history reference to `hash`.
 *
 * Checkpoint writes are upserts: repeated webhook delivery for the same run
 * should not keep incrementing the same blob, and replacing a checkpoint's
 * history hash must release the old blob reference for future GC.
 */
export async function replaceSessionHistoryBlobReference(
  hash: string,
  previousHash: string | null | undefined,
  size: number = 0,
  db: Pick<Database, "insert" | "update"> = globalThis.services.db,
): Promise<string> {
  if (previousHash === hash) {
    return hash;
  }

  await registerSessionHistoryBlob(hash, size, db);

  if (previousHash) {
    await db
      .update(blobs)
      .set({ refCount: sql`${blobs.refCount} - 1` })
      .where(eq(blobs.hash, previousHash));
  }

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
