import { clerkClient } from "@clerk/nextjs/server";

/**
 * Look up a user ID by their email address.
 *
 * @param email - The email address to look up
 * @returns The user ID if found, null otherwise
 */
export async function getUserIdByEmail(email: string): Promise<string | null> {
  const client = await clerkClient();
  const users = await client.users.getUserList({ emailAddress: [email] });
  const user = users.data[0];
  return user?.id ?? null;
}
