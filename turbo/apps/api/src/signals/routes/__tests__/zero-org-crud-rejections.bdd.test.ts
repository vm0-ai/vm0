import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the auth / no-org / sandbox-token / admin-role
// rejections of the org get, update, and leave endpoints — the checks that fire
// before any org row is resolved. The success/update/slug/tier cases read or
// mutate seeded org metadata (tier, cache, Clerk identity) and stay in the kept
// legacy. See `api.bdd.md` (CHAIN-ORG-CRUD-REJECTIONS).
const context = testContext();

describe("org get/update/leave rejections (API-first BDD)", () => {
  it("get rejects unauthenticated and org-less callers", async () => {
    const api = createBddApi(context);

    await accept(api.org.get({ headers: {} }), [401]);

    api.actAsNoOrg();
    const noOrg = await accept(api.org.get({ headers: SESSION_AUTH }), [404]);
    expect(noOrg.body.error.code).toBe("NOT_FOUND");
  });

  it("update rejects unauthenticated, org-less, and sandbox-token callers", async () => {
    const api = createBddApi(context);

    await accept(
      api.org.update({ headers: {}, body: { name: "Updated Org" } }),
      [401],
    );

    api.actAsNoOrg();
    const noOrg = await accept(
      api.org.update({ headers: SESSION_AUTH, body: { name: "Updated Org" } }),
      [400],
    );
    expect(noOrg.body.error.message).toBe(
      "No org configured. Set your org with: zero org set <slug>",
    );

    const zero = await accept(
      api.org.update({
        headers: api.zeroAuth([]),
        body: { name: "Updated Org" },
      }),
      [403],
    );
    expect(zero.body.error.code).toBe("FORBIDDEN");
  });

  it("leave rejects unauthenticated, org-less, sandbox-token, and admin callers", async () => {
    const api = createBddApi(context);

    await accept(api.orgLeave.leave({ headers: {}, body: {} }), [401]);

    api.actAsNoOrg();
    await accept(
      api.orgLeave.leave({ headers: SESSION_AUTH, body: {} }),
      [400],
    );

    const zero = await accept(
      api.orgLeave.leave({ headers: api.zeroAuth([]), body: {} }),
      [403],
    );
    expect(zero.body.error).toStrictEqual({
      message: "This endpoint is not available for sandbox tokens",
      code: "FORBIDDEN",
    });

    // An admin cannot leave their own organization.
    api.actAsAdmin({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    });
    const admin = await accept(
      api.orgLeave.leave({ headers: SESSION_AUTH, body: {} }),
      [403],
    );
    expect(admin.body.error.message).toBe(
      "Admins cannot leave the organization",
    );
  });
});
