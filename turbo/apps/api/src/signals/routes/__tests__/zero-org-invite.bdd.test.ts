import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for org member invites + revokes. Clerk owns
// organization invitations, so creating/revoking them is an external operation:
// the response message is read from the real API, and the role/identity mapping
// is verified through the Clerk invitation mock (its only observable surface).
// See `api.bdd.md` (CHAIN-ORG-INVITE).
const context = testContext();

describe("org invite (API-first BDD)", () => {
  it("invites members with the default and admin roles", async () => {
    const api = createBddApi(context);
    const admin = api.actAsAdmin();
    context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValue(
      undefined,
    );

    // When an admin invites without a role. Then Clerk receives an org:member
    // invitation scoped to the org and inviter.
    const member = await accept(
      api.orgInvite.invite({
        headers: SESSION_AUTH,
        body: { email: "newuser@example.com" },
      }),
      [200],
    );
    expect(member.body.message).toContain("newuser@example.com");
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: admin.orgId,
        emailAddress: "newuser@example.com",
        inviterUserId: admin.userId,
        role: "org:member",
      }),
    );

    // When an admin invites with the admin role. Then Clerk receives org:admin.
    const adminInvite = await accept(
      api.orgInvite.invite({
        headers: SESSION_AUTH,
        body: { email: "admin@example.com", role: "admin" },
      }),
      [200],
    );
    expect(adminInvite.body.message).toContain("admin@example.com");
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).toHaveBeenLastCalledWith(expect.objectContaining({ role: "org:admin" }));
  });

  it("revokes an invitation for an admin", async () => {
    const api = createBddApi(context);
    const admin = api.actAsAdmin();
    const invitationId = `inv_${randomUUID()}`;
    context.mocks.clerk.organizations.revokeOrganizationInvitation.mockResolvedValue(
      undefined,
    );

    const response = await accept(
      api.orgInvite.revoke({ headers: SESSION_AUTH, body: { invitationId } }),
      [200],
    );
    expect(response.body.message).toBe("Invitation revoked");
    expect(
      context.mocks.clerk.organizations.revokeOrganizationInvitation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: admin.orgId, invitationId }),
    );
  });

  it("enforces admin-only access, authentication, org, and validation", async () => {
    const api = createBddApi(context);
    const orgId = `org_${randomUUID()}`;

    // A non-admin member may neither invite nor revoke.
    api.actAsMember({ userId: `user_${randomUUID()}`, orgId });
    const memberInvite = await accept(
      api.orgInvite.invite({
        headers: SESSION_AUTH,
        body: { email: "newuser@example.com" },
      }),
      [403],
    );
    expect(memberInvite.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
    await accept(
      api.orgInvite.revoke({
        headers: SESSION_AUTH,
        body: { invitationId: "inv_test123" },
      }),
      [403],
    );

    // Unauthenticated requests are rejected.
    await accept(
      api.orgInvite.invite({
        headers: {},
        body: { email: "newuser@example.com" },
      }),
      [401],
    );
    await accept(
      api.orgInvite.revoke({
        headers: {},
        body: { invitationId: "inv_test123" },
      }),
      [401],
    );

    // A session with no active organization is rejected.
    api.actAsNoOrg();
    await accept(
      api.orgInvite.invite({
        headers: SESSION_AUTH,
        body: { email: "newuser@example.com" },
      }),
      [401],
    );
    await accept(
      api.orgInvite.revoke({
        headers: SESSION_AUTH,
        body: { invitationId: "inv_test123" },
      }),
      [401],
    );

    // Admin requests with invalid bodies are bad requests.
    api.actAsAdmin({ orgId });
    const badEmail = await accept(
      api.orgInvite.invite({
        headers: SESSION_AUTH,
        body: { email: "not-an-email" },
      }),
      [400],
    );
    expect(badEmail.body.error.code).toBe("BAD_REQUEST");
    const missingId = await accept(
      api.orgInvite.revoke({
        headers: SESSION_AUTH,
        body: {} as { invitationId: string },
      }),
      [400],
    );
    expect(missingId.body.error.code).toBe("BAD_REQUEST");

    // None of the rejected requests reached Clerk.
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.revokeOrganizationInvitation,
    ).not.toHaveBeenCalled();
  });
});
