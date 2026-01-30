/**
 * Session History Service
 * Manages storage and retrieval of CLI agent session history (JSONL)
 * using R2 blob storage for scalability.
 */

import { blobService } from "../blob/blob-service";
import { hashFileContent } from "../storage/content-hash";
import { logger } from "../logger";

const log = logger("service:session-history");

/**
 * Session History Service
 * Stores session history (JSONL) in R2 blob storage with content-addressable hashing
 */
class SessionHistoryService {
  /**
   * Store session history content to R2 blob storage
   *
   * @param content JSONL session history content
   * @returns SHA-256 hash of the content (used as blob reference)
   */
  async store(content: string): Promise<string> {
    const buffer = Buffer.from(content, "utf-8");
    const hash = hashFileContent(buffer);

    log.debug(`Storing session history, hash=${hash}, size=${buffer.length}`);

    // Upload to R2 using blob service (handles deduplication)
    await blobService.uploadBlobs([
      {
        path: `session-history-${hash}.jsonl`,
        content: buffer,
      },
    ]);

    return hash;
  }

  /**
   * Retrieve session history content from R2 blob storage
   *
   * @param hash SHA-256 hash of the content
   * @returns JSONL session history content
   */
  async retrieve(hash: string): Promise<string> {
    log.debug(`Retrieving session history, hash=${hash}`);

    const buffer = await blobService.downloadBlob(hash);
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
  async resolve(
    hash: string | null,
    legacyText: string | null,
  ): Promise<string | null> {
    if (hash) {
      log.debug(`Resolving session history from R2, hash=${hash}`);
      try {
        return await this.retrieve(hash);
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
}

// Export singleton instance
export const sessionHistoryService = new SessionHistoryService();
