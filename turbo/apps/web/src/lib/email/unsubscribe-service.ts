import { clerkClient } from "@clerk/nextjs/server";

/**
 * Check if a user has unsubscribed from system-initiated emails.
 * Reads `email_unsubscribed` from Clerk user publicMetadata.
 */
export async function isUserUnsubscribed(userId: string): Promise<boolean> {
  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  const metadata = user.publicMetadata as Record<string, unknown> | undefined;
  return metadata?.email_unsubscribed === true;
}

/**
 * Unsubscribe a user from system-initiated emails.
 * Sets `email_unsubscribed = true` in Clerk user publicMetadata.
 */
export async function unsubscribeUser(userId: string): Promise<void> {
  const client = await clerkClient();
  await client.users.updateUserMetadata(userId, {
    publicMetadata: { email_unsubscribed: true },
  });
}
