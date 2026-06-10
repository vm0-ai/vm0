import { randomUUID } from "node:crypto";

import { zeroOrgInviteContract } from "@vm0/api-contracts/contracts/zero-org-members";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-org-invite.test.ts`. The 11
// legacy `it()`s collapse into 2 BDD `it()`s: (1) POST chain
// (admin invites with default member role → admin invites with
// admin role → 403 non-admin → 401 unauth → 401 no-org → 400
// invalid email), (2) DELETE chain (admin revokes an invitation
// → 403 non-admin → 401 unauth → 401 no-org → 400 missing
// invitationId).
//
// Service-Level Exception: each step asserts which Clerk API was
// or was not called (mocks are the canonical external
// dependency).

const context = testContext();
const mocks = createZeroRouteMocks(context);

function apiClient() {
  return setupApp({ context })(zeroOrgInviteContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

describe("BDD POST /api/zero/org/invite — full chain", () => {
  it("gwt-wt-wt: admin invites with default member role → admin invites with admin role → 403 non-admin → 401 unauth → 401 no-org → 400 invalid email", async () => {
    const c = apiClient();
    const createOrgInvitation =
      context.mocks.clerk.organizations.createOrganizationInvitation;

    // Given: an admin session.
    const memberUserId = `user_${randomUUID()}`;
    const memberOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(memberUserId, memberOrgId, "org:admin");
    createOrgInvitation.mockResolvedValueOnce(undefined);

    // When: admin invites a member with no role.
    const memberInvite = await accept(
      c.invite({
        headers: authHeaders(),
        body: { email: "newuser@example.com" },
      }),
      [200],
    );

    // Then: success message + Clerk is called with
    // role: "org:member".
    expect(memberInvite.body.message).toContain("newuser@example.com");
    expect(createOrgInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: memberOrgId,
        emailAddress: "newuser@example.com",
        inviterUserId: memberUserId,
        role: "org:member",
      }),
    );

    // Given: a fresh admin session.
    const adminUserId = `user_${randomUUID()}`;
    const adminOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(adminUserId, adminOrgId, "org:admin");
    createOrgInvitation.mockResolvedValueOnce(undefined);

    // When + Then: admin invites an admin (role: "admin" → "org:admin").
    const adminInvite = await accept(
      c.invite({
        headers: authHeaders(),
        body: { email: "admin@example.com", role: "admin" },
      }),
      [200],
    );
    expect(adminInvite.body.message).toContain("admin@example.com");
    expect(createOrgInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ role: "org:admin" }),
    );

    // Given: a non-admin session.
    const memberUserId2 = `user_${randomUUID()}`;
    const memberOrgId2 = `org_${randomUUID()}`;
    mocks.clerk.session(memberUserId2, memberOrgId2, "org:member");

    // When + Then: 403 — non-admin cannot invite.
    const nonAdmin = await accept(
      c.invite({
        headers: authHeaders(),
        body: { email: "newuser@example.com" },
      }),
      [403],
    );
    expect(nonAdmin.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
    expect(createOrgInvitation).toHaveBeenCalledTimes(2);

    // When + Then: 401 with no auth header.
    const noAuth = await accept(
      c.invite({
        headers: {},
        body: { email: "newuser@example.com" },
      }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(createOrgInvitation).toHaveBeenCalledTimes(2);

    // Given: a session with a user but no org.
    const noOrgUserId = `user_${randomUUID()}`;
    mocks.clerk.session(noOrgUserId, null);

    // When + Then: still 401.
    const noOrg = await accept(
      c.invite({
        headers: authHeaders(),
        body: { email: "newuser@example.com" },
      }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(createOrgInvitation).toHaveBeenCalledTimes(2);

    // Given: an admin session.
    const badEmailUserId = `user_${randomUUID()}`;
    const badEmailOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(badEmailUserId, badEmailOrgId, "org:admin");

    // When + Then: 400 — invalid email.
    const badEmail = await accept(
      c.invite({
        headers: authHeaders(),
        body: { email: "not-an-email" },
      }),
      [400],
    );
    expect(badEmail.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(createOrgInvitation).toHaveBeenCalledTimes(2);
  });
});

describe("BDD DELETE /api/zero/org/invite — full chain", () => {
  it("gwt-wt-wt: admin revokes an invitation → 403 non-admin → 401 unauth → 401 no-org → 400 missing invitationId", async () => {
    const c = apiClient();
    const revokeOrgInvitation =
      context.mocks.clerk.organizations.revokeOrganizationInvitation;

    // Given: an admin session.
    const adminUserId = `user_${randomUUID()}`;
    const adminOrgId = `org_${randomUUID()}`;
    const invitationId = `inv_${randomUUID()}`;
    mocks.clerk.session(adminUserId, adminOrgId, "org:admin");
    revokeOrgInvitation.mockResolvedValueOnce(undefined);

    // When: admin revokes an invitation.
    const revoked = await accept(
      c.revoke({
        headers: authHeaders(),
        body: { invitationId },
      }),
      [200],
    );

    // Then: success + Clerk is called with the invitationId.
    expect(revoked.body.message).toBe("Invitation revoked");
    expect(revokeOrgInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: adminOrgId,
        invitationId,
      }),
    );

    // Given: a non-admin session.
    const memberUserId = `user_${randomUUID()}`;
    const memberOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(memberUserId, memberOrgId, "org:member");

    // When + Then: 403 — non-admin cannot revoke.
    const nonAdmin = await accept(
      c.revoke({
        headers: authHeaders(),
        body: { invitationId: "inv_test123" },
      }),
      [403],
    );
    expect(nonAdmin.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
    expect(revokeOrgInvitation).toHaveBeenCalledTimes(1);

    // When + Then: 401 with no auth header.
    const noAuth = await accept(
      c.revoke({
        headers: {},
        body: { invitationId: "inv_test123" },
      }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(revokeOrgInvitation).toHaveBeenCalledTimes(1);

    // Given: a session with a user but no org.
    const noOrgUserId = `user_${randomUUID()}`;
    mocks.clerk.session(noOrgUserId, null);

    // When + Then: still 401.
    const noOrg = await accept(
      c.revoke({
        headers: authHeaders(),
        body: { invitationId: "inv_test123" },
      }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(revokeOrgInvitation).toHaveBeenCalledTimes(1);

    // Given: an admin session.
    const badBodyUserId = `user_${randomUUID()}`;
    const badBodyOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(badBodyUserId, badBodyOrgId, "org:admin");

    // When + Then: 400 — missing invitationId.
    const badBody = await accept(
      c.revoke({
        headers: authHeaders(),
        body: {} as { invitationId: string },
      }),
      [400],
    );
    expect(badBody.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(revokeOrgInvitation).toHaveBeenCalledTimes(1);
  });
});
