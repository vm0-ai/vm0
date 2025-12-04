import { clerkClient } from "@clerk/nextjs/server";

const DEBUG_ALLOWED_DOMAIN = "vm0.ai";

/**
 * Check if a user is allowed to enable debug mode.
 * Only users with @vm0.ai email addresses can enable debug logging.
 *
 * @param userId - The Clerk user ID to check
 * @returns true if the user can enable debug mode, false otherwise
 */
export async function canEnableDebug(userId: string): Promise<boolean> {
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    const email = user.emailAddresses.find(
      (e) => e.id === user.primaryEmailAddressId,
    )?.emailAddress;

    return email?.endsWith(`@${DEBUG_ALLOWED_DOMAIN}`) ?? false;
  } catch {
    return false;
  }
}
