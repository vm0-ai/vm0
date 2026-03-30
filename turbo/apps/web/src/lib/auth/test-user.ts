import { clerkClient } from "@clerk/nextjs/server";

export const DEFAULT_TEST_EMAIL = "dev+clerk_test@serial.dev";

/**
 * Resolve a test user ID by email. If the user doesn't exist in Clerk,
 * creates one automatically. Used by test-token, test-approve, and
 * test-connector endpoints.
 *
 * @param email - the test user's email address
 * @returns the Clerk user ID
 */
export async function resolveTestUserId(email: string): Promise<string> {
  const clerk = await clerkClient();
  const { data: users } = await clerk.users.getUserList({
    emailAddress: [email],
  });

  if (users[0]) {
    return users[0].id;
  }

  // User doesn't exist — create on the fly
  const newUser = await clerk.users.createUser({
    emailAddress: [email],
    skipPasswordRequirement: true,
  });
  return newUser.id;
}
