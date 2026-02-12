import { getAuthProvider } from "./auth-provider";

/**
 * Look up a user ID by their email address.
 *
 * @param email - The email address to look up
 * @returns The user ID if found, null otherwise
 */
export async function getUserIdByEmail(email: string): Promise<string | null> {
  const provider = getAuthProvider();
  return provider.getUserIdByEmail(email);
}
