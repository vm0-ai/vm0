import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the org-members list/update/remove rejections that
// fire before any Clerk membership work: auth, capability, role, and body
// validation. The funded cases (listing real members, updating/removing a
// resolved member) read Clerk membership + user profiles and stay in the kept
// legacy (GAP-CLERK-MEMBERSHIP). See `api.bdd.md` (CHAIN-ORG-MEMBERS-REJECTIONS).
const context = testContext();

describe("org members rejections (API-first BDD)", () => {
  it("list rejects unauthenticated, org-less, and capability-less callers", async () => {
    const api = createBddApi(context);

    await accept(api.orgMembers.members({ headers: {} }), [401]);

    api.actAsNoOrg();
    await accept(api.orgMembers.members({ headers: SESSION_AUTH }), [401]);

    // A zero token without billing:read cannot list members.
    const zero = await accept(
      api.orgMembers.members({ headers: api.zeroAuth([]) }),
      [403],
    );
    expect(zero.body.error.message).toContain(
      "Missing required capability: billing:read",
    );
  });

  it("update rejects unauthenticated, org-less, sandbox, invalid body, and non-admin", async () => {
    const api = createBddApi(context);
    const update = { email: "member@example.com", role: "admin" } as const;

    await accept(
      api.orgMembers.updateRole({ headers: {}, body: update }),
      [401],
    );

    api.actAsNoOrg();
    await accept(
      api.orgMembers.updateRole({ headers: SESSION_AUTH, body: update }),
      [401],
    );

    const zero = await accept(
      api.orgMembers.updateRole({ headers: api.zeroAuth([]), body: update }),
      [403],
    );
    expect(zero.body.error.message).toBe(
      "This endpoint is not available for sandbox tokens",
    );

    // An invalid email is a bad request.
    api.actAsAdmin();
    await accept(
      api.orgMembers.updateRole({
        headers: SESSION_AUTH,
        body: { email: "not-an-email", role: "admin" },
      }),
      [400],
    );

    // A non-admin member cannot update roles.
    api.actAsMember({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    });
    const member = await accept(
      api.orgMembers.updateRole({ headers: SESSION_AUTH, body: update }),
      [403],
    );
    expect(member.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
  });

  it("remove rejects unauthenticated, org-less, sandbox, invalid body, and non-admin", async () => {
    const api = createBddApi(context);
    const remove = { email: "member@example.com" } as const;

    await accept(
      api.orgMembers.removeMember({ headers: {}, body: remove }),
      [401],
    );

    api.actAsNoOrg();
    await accept(
      api.orgMembers.removeMember({ headers: SESSION_AUTH, body: remove }),
      [401],
    );

    const zero = await accept(
      api.orgMembers.removeMember({ headers: api.zeroAuth([]), body: remove }),
      [403],
    );
    expect(zero.body.error.message).toBe(
      "This endpoint is not available for sandbox tokens",
    );

    api.actAsAdmin();
    await accept(
      api.orgMembers.removeMember({
        headers: SESSION_AUTH,
        body: { email: "not-an-email" },
      }),
      [400],
    );

    api.actAsMember({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    });
    const member = await accept(
      api.orgMembers.removeMember({ headers: SESSION_AUTH, body: remove }),
      [403],
    );
    expect(member.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
  });
});
