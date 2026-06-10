import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the org list endpoint. Clerk owns organization
// membership, so the membership set is the one external precondition we mock;
// everything else is a real HTTP request through the app. See `api.bdd.md`
// (CHAIN-ORG-LIST).
const context = testContext();

describe("org list (API-first BDD)", () => {
  it("maps the caller's Clerk memberships to slug + role", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();

    // Given a single admin membership.
    const slug = `solo-${randomUUID().slice(0, 8)}`;
    api.mockOrgMemberships([
      { orgId: `org_${randomUUID()}`, slug, role: "org:admin" },
    ]);

    // When the caller lists their orgs. Then the admin role is mapped through.
    const single = await accept(
      api.orgList.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(single.body.orgs).toStrictEqual([{ slug, role: "admin" }]);
    expect(single.body.active).toBeUndefined();

    // Given memberships across several orgs with mixed roles.
    api.mockOrgMemberships([
      { orgId: `org_${randomUUID()}`, slug: "team-alpha", role: "org:admin" },
      { orgId: `org_${randomUUID()}`, slug: "team-beta", role: "org:member" },
    ]);

    // When the caller lists again. Then each role is mapped independently.
    const several = await accept(
      api.orgList.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(several.body.orgs).toStrictEqual([
      { slug: "team-alpha", role: "admin" },
      { slug: "team-beta", role: "member" },
    ]);
    expect(several.body.active).toBeUndefined();
  });

  it("returns 401 when unauthenticated", async () => {
    const api = createBddApi(context);

    const response = await accept(api.orgList.list({ headers: {} }), [401]);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
});
