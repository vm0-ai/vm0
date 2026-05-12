import { randomUUID } from "node:crypto";

import { zeroOrgLogoContract } from "@vm0/api-contracts/contracts/zero-org-logo";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
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

function mockClerkOrganizationLogoUpload(
  args: ClerkOrganizationLogoFixture,
): void {
  context.mocks.clerk.organizations.updateOrganizationLogo.mockResolvedValue({
    id: args.orgId,
    imageUrl: args.imageUrl,
    hasImage: args.hasImage,
  });
}

function mockClerkOrganizationLogoDelete(
  args: ClerkOrganizationLogoFixture,
): void {
  context.mocks.clerk.organizations.deleteOrganizationLogo.mockResolvedValue({
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

function clerkForbiddenError(): Error {
  const error = new Error("Forbidden");
  error.name = "ForbiddenError";
  return error;
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function logoForm(file: File): FormData {
  const form = new FormData();
  form.append("file", file);
  return form;
}

function pngLogoFile(): File {
  return new File([new Uint8Array([137, 80, 78, 71])], "logo.png", {
    type: "image/png",
  });
}

function postLogo(form: FormData, headers: HeadersInit = {}) {
  const app = createApp({ signal: context.signal });
  return app.request("/api/zero/org/logo", {
    method: "POST",
    headers,
    body: form,
  });
}

function deleteLogo(headers: HeadersInit = {}) {
  const app = createApp({ signal: context.signal });
  return app.request("/api/zero/org/logo", {
    method: "DELETE",
    headers,
  });
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

describe("POST /api/zero/org/logo", () => {
  it("uploads the current org logo", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");
    mockClerkOrganizationLogoUpload({
      orgId,
      imageUrl: "https://img.clerk.test/new-logo.png",
      hasImage: true,
    });

    const file = pngLogoFile();
    const response = await postLogo(logoForm(file), {
      authorization: "Bearer clerk-session",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      logoUrl: "https://img.clerk.test/new-logo.png",
      hasImage: true,
    });
    expect(
      context.mocks.clerk.organizations.updateOrganizationLogo,
    ).toHaveBeenCalledWith(orgId, { file });
  });

  it("returns null logoUrl when Clerk clears the image URL", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");
    mockClerkOrganizationLogoUpload({
      orgId,
      imageUrl: "",
      hasImage: false,
    });

    const response = await postLogo(logoForm(pngLogoFile()), {
      authorization: "Bearer clerk-session",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      logoUrl: null,
      hasImage: false,
    });
  });

  it("returns 401 when not authenticated", async () => {
    const response = await postLogo(logoForm(pngLogoFile()));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(
      context.mocks.clerk.organizations.updateOrganizationLogo,
    ).not.toHaveBeenCalled();
  });

  it("returns 404 when the session has no active org", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);

    const response = await postLogo(logoForm(pngLogoFile()), {
      authorization: "Bearer clerk-session",
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Org not found", code: "BAD_REQUEST" },
    });
    expect(
      context.mocks.clerk.organizations.updateOrganizationLogo,
    ).not.toHaveBeenCalled();
  });

  it("returns 403 when the current org role is not admin", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:member");

    const response = await postLogo(logoForm(pngLogoFile()), {
      authorization: "Bearer clerk-session",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Only admins can upload the logo",
        code: "BAD_REQUEST",
      },
    });
    expect(
      context.mocks.clerk.organizations.updateOrganizationLogo,
    ).not.toHaveBeenCalled();
  });

  it("returns 400 when no file is provided", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");

    const response = await postLogo(new FormData(), {
      authorization: "Bearer clerk-session",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "No file provided", code: "BAD_REQUEST" },
    });
    expect(
      context.mocks.clerk.organizations.updateOrganizationLogo,
    ).not.toHaveBeenCalled();
  });

  it("returns 400 when the file field is not a file", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");
    const form = new FormData();
    form.append("file", "not-a-file");

    const response = await postLogo(form, {
      authorization: "Bearer clerk-session",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "No file provided", code: "BAD_REQUEST" },
    });
    expect(
      context.mocks.clerk.organizations.updateOrganizationLogo,
    ).not.toHaveBeenCalled();
  });

  it("returns 400 when the file is too large", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");
    const file = new File([new Uint8Array(2 * 1024 * 1024 + 1)], "logo.png", {
      type: "image/png",
    });

    const response = await postLogo(logoForm(file), {
      authorization: "Bearer clerk-session",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "File too large (max 2 MB)", code: "BAD_REQUEST" },
    });
    expect(
      context.mocks.clerk.organizations.updateOrganizationLogo,
    ).not.toHaveBeenCalled();
  });

  it("returns 400 for unsupported file types", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");
    const file = new File(["plain"], "logo.txt", { type: "text/plain" });

    const response = await postLogo(logoForm(file), {
      authorization: "Bearer clerk-session",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Unsupported file type: text/plain",
        code: "BAD_REQUEST",
      },
    });
    expect(
      context.mocks.clerk.organizations.updateOrganizationLogo,
    ).not.toHaveBeenCalled();
  });

  it("maps Clerk not-found errors to 404", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");
    context.mocks.clerk.organizations.updateOrganizationLogo.mockRejectedValue(
      clerkNotFoundError(),
    );

    const response = await postLogo(logoForm(pngLogoFile()), {
      authorization: "Bearer clerk-session",
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Org not found", code: "BAD_REQUEST" },
    });
  });

  it("maps Clerk forbidden errors to 403", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");
    context.mocks.clerk.organizations.updateOrganizationLogo.mockRejectedValue(
      clerkForbiddenError(),
    );

    const response = await postLogo(logoForm(pngLogoFile()), {
      authorization: "Bearer clerk-session",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Access denied", code: "BAD_REQUEST" },
    });
  });

  it("rejects zero tokens", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId,
      orgId,
      runId: `run_${randomUUID()}`,
      capabilities: [],
      iat: seconds,
      exp: seconds + 600,
    });

    const response = await postLogo(logoForm(pngLogoFile()), {
      authorization: `Bearer ${token}`,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "This endpoint is not available for sandbox tokens",
        code: "FORBIDDEN",
      },
    });
    expect(
      context.mocks.clerk.organizations.updateOrganizationLogo,
    ).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/zero/org/logo", () => {
  it("removes the current org logo", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");
    mockClerkOrganizationLogoDelete({
      orgId,
      imageUrl: "https://img.clerk.test/default-logo.png",
      hasImage: true,
    });

    const response = await deleteLogo({
      authorization: "Bearer clerk-session",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      logoUrl: "https://img.clerk.test/default-logo.png",
      hasImage: true,
    });
    expect(
      context.mocks.clerk.organizations.deleteOrganizationLogo,
    ).toHaveBeenCalledWith(orgId);
  });

  it("returns null logoUrl when Clerk clears the image URL", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");
    mockClerkOrganizationLogoDelete({
      orgId,
      imageUrl: "",
      hasImage: false,
    });

    const response = await deleteLogo({
      authorization: "Bearer clerk-session",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      logoUrl: null,
      hasImage: false,
    });
  });

  it("returns 401 when not authenticated", async () => {
    const response = await deleteLogo();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(
      context.mocks.clerk.organizations.deleteOrganizationLogo,
    ).not.toHaveBeenCalled();
  });

  it("returns 404 when the session has no active org", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);

    const response = await deleteLogo({
      authorization: "Bearer clerk-session",
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Org not found", code: "BAD_REQUEST" },
    });
    expect(
      context.mocks.clerk.organizations.deleteOrganizationLogo,
    ).not.toHaveBeenCalled();
  });

  it("returns 403 when the current org role is not admin", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:member");

    const response = await deleteLogo({
      authorization: "Bearer clerk-session",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Only admins can remove the logo",
        code: "BAD_REQUEST",
      },
    });
    expect(
      context.mocks.clerk.organizations.deleteOrganizationLogo,
    ).not.toHaveBeenCalled();
  });

  it("maps Clerk not-found errors to 404", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");
    context.mocks.clerk.organizations.deleteOrganizationLogo.mockRejectedValue(
      clerkNotFoundError(),
    );

    const response = await deleteLogo({
      authorization: "Bearer clerk-session",
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Org not found", code: "BAD_REQUEST" },
    });
  });

  it("maps Clerk forbidden errors to 403", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");
    context.mocks.clerk.organizations.deleteOrganizationLogo.mockRejectedValue(
      clerkForbiddenError(),
    );

    const response = await deleteLogo({
      authorization: "Bearer clerk-session",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Access denied", code: "BAD_REQUEST" },
    });
  });

  it("rejects zero tokens", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId,
      orgId,
      runId: `run_${randomUUID()}`,
      capabilities: [],
      iat: seconds,
      exp: seconds + 600,
    });

    const response = await deleteLogo({
      authorization: `Bearer ${token}`,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "This endpoint is not available for sandbox tokens",
        code: "FORBIDDEN",
      },
    });
    expect(
      context.mocks.clerk.organizations.deleteOrganizationLogo,
    ).not.toHaveBeenCalled();
  });
});
