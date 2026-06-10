import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the org-delete rejections. The org identity (and
// its slug) come from Clerk, so the slug-mismatch and missing-identity cases are
// reachable by mocking Clerk `getOrganization`; the role comes from the session.
// The successful cascade delete needs seeded org data (org cache, integrations,
// members) with no API surface (GAP-ORG-DELETE-CASCADE) and stays in the kept
// legacy. See `api.bdd.md` (CHAIN-ORG-DELETE).
const context = testContext();

function mockClerkOrgSlug(orgId: string, slug: string): void {
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: orgId,
    slug,
  });
}

describe("org delete rejections (API-first BDD)", () => {
  it("rejects unauthenticated, org-less, and zero-token callers", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    const unauth = await accept(
      api.orgDelete.delete({ headers: {}, body: { slug: "any" } }),
      [401],
    );
    expect(unauth.body.error.code).toBe("UNAUTHORIZED");

    // No active organization.
    api.actAsNoOrg();
    await accept(
      api.orgDelete.delete({ headers: SESSION_AUTH, body: { slug: "any" } }),
      [401],
    );

    // Zero (sandbox) tokens are not allowed; Clerk is never touched.
    const zero = await accept(
      api.orgDelete.delete({
        headers: api.zeroAuth([]),
        body: { slug: "any" },
      }),
      [403],
    );
    expect(zero.body.error).toStrictEqual({
      message: "This endpoint is not available for sandbox tokens",
      code: "FORBIDDEN",
    });
    expect(
      context.mocks.clerk.organizations.deleteOrganization,
    ).not.toHaveBeenCalled();
  });

  it("validates the confirmation slug and enforces admin-only access", async () => {
    const api = createBddApi(context);

    // A non-admin member cannot delete.
    const orgId = `org_${randomUUID()}`;
    api.actAsMember({ userId: `user_${randomUUID()}`, orgId });
    const member = await accept(
      api.orgDelete.delete({ headers: SESSION_AUTH, body: { slug: "any" } }),
      [403],
    );
    expect(member.body.error.message).toBe(
      "Only admins can delete the organization",
    );

    // An admin with a missing slug body is a bad request.
    const adminOrg = `org_${randomUUID()}`;
    api.actAsAdmin({ orgId: adminOrg });
    mockClerkOrgSlug(adminOrg, "real-slug");
    const badBody = await accept(
      api.orgDelete.delete({
        headers: SESSION_AUTH,
        body: {} as { slug: string },
      }),
      [400],
    );
    expect(badBody.body.error.code).toBe("BAD_REQUEST");

    // An admin whose confirmation slug does not match the org is rejected.
    const mismatch = await accept(
      api.orgDelete.delete({
        headers: SESSION_AUTH,
        body: { slug: `different-${randomUUID().slice(0, 8)}` },
      }),
      [400],
    );
    expect(mismatch.body.error.message).toBe(
      "Organization name does not match",
    );

    expect(
      context.mocks.clerk.organizations.deleteOrganization,
    ).not.toHaveBeenCalled();
  });

  it("returns 404 when the Clerk org identity is missing", async () => {
    const api = createBddApi(context);
    const orgId = `org_${randomUUID()}`;
    api.actAsAdmin({ orgId });
    const notFound = new Error("Organization not found");
    notFound.name = "NotFoundError";
    context.mocks.clerk.organizations.getOrganization.mockRejectedValue(
      notFound,
    );

    const response = await accept(
      api.orgDelete.delete({ headers: SESSION_AUTH, body: { slug: "any" } }),
      [404],
    );
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(
      context.mocks.clerk.organizations.deleteOrganization,
    ).not.toHaveBeenCalled();
  });
});
