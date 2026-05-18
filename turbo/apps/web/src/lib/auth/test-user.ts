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

/**
 * Pick a deterministic Clerk org for a test user.
 *
 * If the test user accumulates multiple orgs (e.g. through CI test
 * pollution), Clerk does not guarantee iteration order. Sort by
 * membership `createdAt` ascending so every caller targets the oldest
 * org — both `ensureTestOrg` (CLI test-token route) and the Slack
 * test-state seeder resolve to the same org.
 *
 * Throws if the user has no memberships.
 */
export async function resolveTestOrgId(userId: string): Promise<string> {
  const clerk = await clerkClient();
  const memberships = await clerk.users.getOrganizationMembershipList({
    userId,
  });
  const sorted = [...memberships.data].sort((a, b) => {
    return a.createdAt - b.createdAt;
  });
  const orgId = sorted[0]?.organization.id;
  if (!orgId) {
    throw new Error(`Test user ${userId} has no organization membership`);
  }
  return orgId;
}
