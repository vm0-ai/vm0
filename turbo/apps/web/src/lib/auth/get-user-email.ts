import { clerkClient } from "@clerk/nextjs/server";

/**
 * Get user's primary email address from Clerk
 */
export async function getUserEmail(userId: string): Promise<string> {
  const client = await clerkClient();
  const user = await client.users.getUser(userId);

  const email = user.emailAddresses.find(
    (e) => e.id === user.primaryEmailAddressId,
  )?.emailAddress;

  return email || "";
}
