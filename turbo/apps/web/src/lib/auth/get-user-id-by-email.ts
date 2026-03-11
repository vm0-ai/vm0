import { getCachedUserIdByEmail } from "./user-cache-service";

/**
 * Look up a user ID by their email address.
 * Uses DB cache (1-min TTL) to avoid hitting Clerk API on every call.
 *
 * @param email - The email address to look up
 * @returns The user ID if found, null otherwise
 */
export async function getUserIdByEmail(email: string): Promise<string | null> {
  return getCachedUserIdByEmail(email);
}
