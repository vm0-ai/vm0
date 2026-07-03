import type { TestContext } from "../../../../__tests__/test-context";
import type { ApiTestUser } from "./api-bdd";

/**
 * Membership reads for routes that resolve org roles outside the Clerk
 * session. The role for a given (user, org) pair is cached for 60 seconds
 * after the first read, so tests must use a distinct user per role scenario.
 */
export function mockClerkMembership(
  context: TestContext,
  actor: ApiTestUser,
  role: "org:admin" | "org:member",
): void {
  if (!actor.orgId) {
    throw new Error("Cannot mock memberships for a no-org actor");
  }
  const memberships = {
    data: [
      {
        role,
        organization: { id: actor.orgId },
        publicUserData: { userId: actor.userId },
      },
    ],
  };
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
    memberships,
  );
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    memberships,
  );
}
