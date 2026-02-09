import { getAuthProvider } from "./auth-provider";

/**
 * Get user's primary email address
 */
export async function getUserEmail(userId: string): Promise<string> {
  const provider = getAuthProvider();
  return provider.getUserEmail(userId);
}
