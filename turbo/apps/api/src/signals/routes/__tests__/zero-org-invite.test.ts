import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { zeroOrgInviteContract } from "@vm0/api-contracts/contracts/zero-org-members";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

function apiClient() {
  return setupApp({ context })(zeroOrgInviteContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

describe("POST /api/zero/org/invite", () => {
  it("invites a member with the default role (org:member)", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");
    context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValueOnce(
      undefined,
    );

    const response = await accept(
      apiClient().invite({
        headers: authHeaders(),
        body: { email: "newuser@example.com" },
      }),
      [200],
    );

    expect(response.body.message).toContain("newuser@example.com");
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: orgId,
        emailAddress: "newuser@example.com",
        inviterUserId: userId,
        role: "org:member",
      }),
    );
  });

  it("invites a member with admin role", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");
    context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValueOnce(
      undefined,
    );

    const response = await accept(
      apiClient().invite({
        headers: authHeaders(),
        body: { email: "admin@example.com", role: "admin" },
      }),
      [200],
    );

    expect(response.body.message).toContain("admin@example.com");
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).toHaveBeenCalledWith(expect.objectContaining({ role: "org:admin" }));
  });

  it("returns 403 when the caller is not an admin", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:member");

    const response = await accept(
      apiClient().invite({
        headers: authHeaders(),
        body: { email: "newuser@example.com" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).not.toHaveBeenCalled();
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      apiClient().invite({
        headers: {},
        body: { email: "newuser@example.com" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).not.toHaveBeenCalled();
  });

  it("returns 401 when the authenticated session has no active organization", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);

    const response = await accept(
      apiClient().invite({
        headers: authHeaders(),
        body: { email: "newuser@example.com" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid email address", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");

    const response = await accept(
      apiClient().invite({
        headers: authHeaders(),
        body: { email: "not-an-email" },
      }),
      [400],
    );

    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/zero/org/invite", () => {
  it("revokes an invitation for an admin", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const invitationId = `inv_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");
    context.mocks.clerk.organizations.revokeOrganizationInvitation.mockResolvedValueOnce(
      undefined,
    );

    const response = await accept(
      apiClient().revoke({
        headers: authHeaders(),
        body: { invitationId },
      }),
      [200],
    );

    expect(response.body.message).toBe("Invitation revoked");
    expect(
      context.mocks.clerk.organizations.revokeOrganizationInvitation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: orgId,
        invitationId,
      }),
    );
  });

  it("returns 403 when the caller is not an admin", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:member");

    const response = await accept(
      apiClient().revoke({
        headers: authHeaders(),
        body: { invitationId: "inv_test123" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
    expect(
      context.mocks.clerk.organizations.revokeOrganizationInvitation,
    ).not.toHaveBeenCalled();
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      apiClient().revoke({
        headers: {},
        body: { invitationId: "inv_test123" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(
      context.mocks.clerk.organizations.revokeOrganizationInvitation,
    ).not.toHaveBeenCalled();
  });

  it("returns 401 when the authenticated session has no active organization", async () => {
    // Deliberate hardening: web returns 400 (resolveOrg throw → isBadRequest);
    // api returns 401 (authRoute's missingOrganizationStatus). See PR body.
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);

    const response = await accept(
      apiClient().revoke({
        headers: authHeaders(),
        body: { invitationId: "inv_test123" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(
      context.mocks.clerk.organizations.revokeOrganizationInvitation,
    ).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid body (missing invitationId)", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");

    const response = await accept(
      apiClient().revoke({
        headers: authHeaders(),
        body: {} as { invitationId: string },
      }),
      [400],
    );

    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(
      context.mocks.clerk.organizations.revokeOrganizationInvitation,
    ).not.toHaveBeenCalled();
  });
});
