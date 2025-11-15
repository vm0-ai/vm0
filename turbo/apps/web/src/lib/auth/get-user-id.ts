import { auth } from "@clerk/nextjs/server";

/**
 * Get the current user ID from Clerk
 * Returns null if not authenticated
 */
export async function getUserId(): Promise<string | null> {
  const { userId } = await auth();
  return userId;
}
