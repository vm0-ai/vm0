import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { zeroOrgInviteContract } from "@vm0/api-contracts/contracts/zero-org-members";

import { createApp } from "../../../app-factory";
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

async function rawInviteRequest(
  method: "DELETE",
  body: object,
): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return await app.request("/api/zero/org/invite", {
    method,
    headers: {
      ...authHeaders(),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/zero/org/invite BDD", () => {
  it("enforces invite boundaries and sends member/admin invitations", async () => {
    const client = apiClient();
    const createInvitation =
      context.mocks.clerk.organizations.createOrganizationInvitation;

    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");
    createInvitation.mockResolvedValueOnce(undefined);

    const memberInvite = await accept(
      client.invite({
        headers: authHeaders(),
        body: { email: "newuser@example.com" },
      }),
      [200],
    );

    expect(memberInvite.body.message).toContain("newuser@example.com");
    expect(createInvitation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        organizationId: orgId,
        emailAddress: "newuser@example.com",
        inviterUserId: userId,
        role: "org:member",
      }),
    );

    createInvitation.mockResolvedValueOnce(undefined);
    const adminInvite = await accept(
      client.invite({
        headers: authHeaders(),
        body: { email: "admin@example.com", role: "admin" },
      }),
      [200],
    );

    expect(adminInvite.body.message).toContain("admin@example.com");
    expect(createInvitation).toHaveBeenLastCalledWith(
      expect.objectContaining({ role: "org:admin" }),
    );

    createInvitation.mockClear();
    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:member",
    );
    const forbidden = await accept(
      client.invite({
        headers: authHeaders(),
        body: { email: "newuser@example.com" },
      }),
      [403],
    );

    expect(forbidden.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
    expect(createInvitation).not.toHaveBeenCalled();

    const unauthenticated = await accept(
      client.invite({
        headers: {},
        body: { email: "newuser@example.com" },
      }),
      [401],
    );

    expect(unauthenticated.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(createInvitation).not.toHaveBeenCalled();

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noActiveOrg = await accept(
      client.invite({
        headers: authHeaders(),
        body: { email: "newuser@example.com" },
      }),
      [401],
    );

    expect(noActiveOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(createInvitation).not.toHaveBeenCalled();

    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:admin",
    );
    const invalidEmail = await accept(
      client.invite({
        headers: authHeaders(),
        body: { email: "not-an-email" },
      }),
      [400],
    );

    expect(invalidEmail.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(createInvitation).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/zero/org/invite BDD", () => {
  it("enforces revoke boundaries and revokes admin invitations", async () => {
    const client = apiClient();
    const revokeInvitation =
      context.mocks.clerk.organizations.revokeOrganizationInvitation;

    const orgId = `org_${randomUUID()}`;
    const invitationId = `inv_${randomUUID()}`;
    mocks.clerk.session(`user_${randomUUID()}`, orgId, "org:admin");
    revokeInvitation.mockResolvedValueOnce(undefined);

    const revoked = await accept(
      client.revoke({
        headers: authHeaders(),
        body: { invitationId },
      }),
      [200],
    );

    expect(revoked.body.message).toBe("Invitation revoked");
    expect(revokeInvitation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        organizationId: orgId,
        invitationId,
      }),
    );

    revokeInvitation.mockClear();
    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:member",
    );
    const forbidden = await accept(
      client.revoke({
        headers: authHeaders(),
        body: { invitationId: "inv_test123" },
      }),
      [403],
    );

    expect(forbidden.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
    expect(revokeInvitation).not.toHaveBeenCalled();

    const unauthenticated = await accept(
      client.revoke({
        headers: {},
        body: { invitationId: "inv_test123" },
      }),
      [401],
    );

    expect(unauthenticated.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(revokeInvitation).not.toHaveBeenCalled();

    // Deliberate hardening: web returns 400; API authRoute returns 401.
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noActiveOrg = await accept(
      client.revoke({
        headers: authHeaders(),
        body: { invitationId: "inv_test123" },
      }),
      [401],
    );

    expect(noActiveOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(revokeInvitation).not.toHaveBeenCalled();

    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:admin",
    );
    const invalidBody = await rawInviteRequest("DELETE", {});

    expect(invalidBody.status).toBe(400);
    await expect(invalidBody.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(revokeInvitation).not.toHaveBeenCalled();
  });
});
