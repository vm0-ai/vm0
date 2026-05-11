import { randomUUID } from "node:crypto";

import { zeroOrgListContract } from "@vm0/api-contracts/contracts/zero-org-list";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface ClerkOrgMembershipFixture {
  readonly orgId: string;
  readonly slug: string;
  readonly role: "org:admin" | "org:member";
}

function mockUserOrganizationMemberships(
  memberships: readonly ClerkOrgMembershipFixture[],
): void {
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: memberships.map((membership) => {
      return {
        organization: {
          id: membership.orgId,
          slug: membership.slug,
        },
        role: membership.role,
      };
    }),
  });
}

describe("GET /api/zero/org/list", () => {
  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroOrgListContract);

    const response = await accept(client.list({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns list of user orgs", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const slug = `solo-${randomUUID().slice(0, 8)}`;
    mockUserOrganizationMemberships([{ orgId, slug, role: "org:admin" }]);
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroOrgListContract);

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.orgs).toStrictEqual([{ slug, role: "admin" }]);
    expect(response.body.active).toBeUndefined();
    expect(
      context.mocks.clerk.users.getOrganizationMembershipList,
    ).toHaveBeenCalledWith({ userId });
  });

  it("returns multiple orgs when user belongs to several", async () => {
    const userId = `user_${randomUUID()}`;
    const orgIdA = `org_${randomUUID()}`;
    const orgIdB = `org_${randomUUID()}`;
    mockUserOrganizationMemberships([
      { orgId: orgIdA, slug: "team-alpha", role: "org:admin" },
      { orgId: orgIdB, slug: "team-beta", role: "org:member" },
    ]);
    mocks.clerk.session(userId, orgIdA);

    const client = setupApp({ context })(zeroOrgListContract);

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.orgs).toStrictEqual([
      { slug: "team-alpha", role: "admin" },
      { slug: "team-beta", role: "member" },
    ]);
    expect(response.body.active).toBeUndefined();
  });
});
