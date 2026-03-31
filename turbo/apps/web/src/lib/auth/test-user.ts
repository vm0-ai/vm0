import { clerkClient } from "@clerk/nextjs/server";

export const DEFAULT_TEST_EMAIL = "dev+clerk_test+serial@vm0-e2e.ai";

/**
 * Resolve the test user ID by querying Clerk Backend API for the e2e test user.
 * Throws if the user is not found (accounts must be pre-provisioned by CI).
 *
 * @param email - the email address of the test user to look up
 */
export async function resolveTestUserId(
  email: string = DEFAULT_TEST_EMAIL,
): Promise<string> {
  const clerk = await clerkClient();
  const { data: users } = await clerk.users.getUserList({
    emailAddress: [email],
  });
  const userId = users[0]?.id;
  if (!userId) {
    throw new Error(`Test user not found for email: ${email}`);
  }
  return userId;
}
