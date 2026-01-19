import { sessionHistoryService } from "../../session-history";
import { NotFoundError } from "../../errors";

/**
 * Resolve session history from conversation record
 * Uses R2 hash if available, falls back to legacy TEXT field
 *
 * @param hash SHA-256 hash reference (new records)
 * @param legacyText Legacy TEXT field content (old records)
 * @returns Session history content
 * @throws NotFoundError if session history cannot be resolved
 */
export async function resolveSessionHistory(
  hash: string | null,
  legacyText: string | null,
): Promise<string> {
  const sessionHistory = await sessionHistoryService.resolve(hash, legacyText);
  if (!sessionHistory) {
    throw new NotFoundError("Session history not found for conversation");
  }
  return sessionHistory;
}
