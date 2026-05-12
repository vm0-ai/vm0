import { randomUUID } from "node:crypto";

import { zeroOrgLogoContract } from "@vm0/api-contracts/contracts/zero-org-logo";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface ClerkOrganizationLogoFixture {
  readonly orgId: string;
  readonly imageUrl: string | null;
  readonly hasImage: boolean;
}

function mockClerkOrganizationLogo(args: ClerkOrganizationLogoFixture): void {
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: args.orgId,
    imageUrl: args.imageUrl,
    hasImage: args.hasImage,
  });
}

function clerkNotFoundError(): Error {
  const error = new Error("Organization not found");
  error.name = "NotFoundError";
  return error;
}

describe("GET /api/zero/org/logo", () => {
  it("returns the current org logo metadata", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    mockClerkOrganizationLogo({
      orgId,
      imageUrl: "https://img.clerk.test/org-logo.png",
      hasImage: true,
    });

    const client = setupApp({ context })(zeroOrgLogoContract);
    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body).toStrictEqual({
      logoUrl: "https://img.clerk.test/org-logo.png",
      hasImage: true,
    });
    expect(
      context.mocks.clerk.organizations.getOrganization,
    ).toHaveBeenCalledWith({ organizationId: orgId });
  });

  it("returns null logoUrl when Clerk has no org image URL", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    mockClerkOrganizationLogo({
      orgId,
      imageUrl: "",
      hasImage: false,
    });

    const client = setupApp({ context })(zeroOrgLogoContract);
    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body).toStrictEqual({
      logoUrl: null,
      hasImage: false,
    });
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroOrgLogoContract);
    const response = await accept(client.get({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
    expect(
      context.mocks.clerk.organizations.getOrganization,
    ).not.toHaveBeenCalled();
  });

  it("returns 404 when the session has no active org", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);

    const client = setupApp({ context })(zeroOrgLogoContract);
    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [404],
    );

    expect(response.body.error).toStrictEqual({
      message: "Org not found",
      code: "BAD_REQUEST",
    });
    expect(
      context.mocks.clerk.organizations.getOrganization,
    ).not.toHaveBeenCalled();
  });

  it("maps Clerk not-found errors to 404", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    context.mocks.clerk.organizations.getOrganization.mockRejectedValue(
      clerkNotFoundError(),
    );

    const client = setupApp({ context })(zeroOrgLogoContract);
    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [404],
    );

    expect(response.body.error).toStrictEqual({
      message: "Org not found",
      code: "BAD_REQUEST",
    });
  });
});
