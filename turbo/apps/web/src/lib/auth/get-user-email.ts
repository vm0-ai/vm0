import { getCachedUser } from "./user-cache-service";

/**
 * Get user's primary email address.
 * Uses DB cache (1-min TTL) to avoid hitting Clerk API on every call.
 */
export async function getUserEmail(userId: string): Promise<string> {
  const { email } = await getCachedUser(userId);
  return email;
}
