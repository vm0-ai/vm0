import { clerkClient } from "@clerk/nextjs/server";

/**
 * Get user's primary email address
 */
export async function getUserEmail(userId: string): Promise<string> {
  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  const email = user.emailAddresses.find(
    (e) => e.id === user.primaryEmailAddressId,
  )?.emailAddress;
  if (!email) {
    throw new Error(`No primary email found for user ${userId}`);
  }
  return email;
}
