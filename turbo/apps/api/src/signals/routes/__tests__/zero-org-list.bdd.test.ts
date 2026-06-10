import { randomUUID } from "node:crypto";

import { zeroOrgListContract } from "@vm0/api-contracts/contracts/zero-org-list";
import { expect } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-org-list.test.ts`. The route is purely
// a Clerk-membership projection: no DB writes, no fixtures. All
// preconditions are built by mocking the Clerk `getOrganizationMembershipList`
// response and the `authenticateRequest` session — these are external service
// mocks, not internal state, and so are BDD-acceptable per `api.bdd.md`.
//
// The legacy `it()`s are collapsed into two GWT-WT-WT chains that share the
// "Clerk session + a mocked membership list" Given: one for the
// single-org path, one for the multi-org path. Auth-boundary stays as a
// separate small test.

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

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroOrgListContract);
}

describe("BDD GET /api/zero/org/list — auth boundary", () => {
  it("returns 401 when not authenticated", async () => {
    const response = await accept(client().list({ headers: {} }), [401]);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("BDD GET /api/zero/org/list — membership projection chain", () => {
  it("gwt-wt-wt: single org → user belongs to several → active org tracked", async () => {
    // Given: a user with a single org membership.
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const slug = `solo-${randomUUID().slice(0, 8)}`;
    mockUserOrganizationMemberships([{ orgId, slug, role: "org:admin" }]);
    mocks.clerk.session(userId, orgId);
    const c = client();

    // When + Then: the response projects the membership list and leaves
    // `active` undefined (the active org is set by the session, not the
    // membership list).
    const single = await accept(c.list({ headers: authHeaders() }), [200]);
    expect(single.body.orgs).toStrictEqual([{ slug, role: "admin" }]);
    expect(single.body.active).toBeUndefined();
    expect(
      context.mocks.clerk.users.getOrganizationMembershipList,
    ).toHaveBeenCalledWith({ userId });

    // Given: the same user now belongs to multiple orgs (a different
    // mocked membership list).
    const orgIdA = `org_${randomUUID()}`;
    const orgIdB = `org_${randomUUID()}`;
    mockUserOrganizationMemberships([
      { orgId: orgIdA, slug: "team-alpha", role: "org:admin" },
      { orgId: orgIdB, slug: "team-beta", role: "org:member" },
    ]);
    mocks.clerk.session(userId, orgIdA);

    // When + Then: the response includes every membership, with the
    // session's active org reflected (none, in this case).
    const multi = await accept(c.list({ headers: authHeaders() }), [200]);
    expect(multi.body.orgs).toStrictEqual([
      { slug: "team-alpha", role: "admin" },
      { slug: "team-beta", role: "member" },
    ]);
    expect(multi.body.active).toBeUndefined();
  });
});
