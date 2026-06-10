import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

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

function apiClient() {
  return setupApp({ context })(zeroOrgLogoContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function mockClerkOrganizationLogo(args: ClerkOrganizationLogoFixture): void {
  context.mocks.clerk.organizations.getOrganization.mockResolvedValueOnce({
    id: args.orgId,
    imageUrl: args.imageUrl,
    hasImage: args.hasImage,
  });
}

function mockClerkOrganizationLogoUpload(
  args: ClerkOrganizationLogoFixture,
): void {
  context.mocks.clerk.organizations.updateOrganizationLogo.mockResolvedValueOnce(
    {
      id: args.orgId,
      imageUrl: args.imageUrl,
      hasImage: args.hasImage,
    },
  );
}

function mockClerkOrganizationLogoDelete(
  args: ClerkOrganizationLogoFixture,
): void {
  context.mocks.clerk.organizations.deleteOrganizationLogo.mockResolvedValueOnce(
    {
      id: args.orgId,
      imageUrl: args.imageUrl,
      hasImage: args.hasImage,
    },
  );
}

function clerkNotFoundError(): Error {
  const error = new Error("Organization not found");
  error.name = "NotFoundError";
  return error;
}

function clerkBadRequestError(): Error {
  const error = new Error("Invalid organization");
  error.name = "BadRequestError";
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

function sandboxAuthHeaders() {
  const seconds = currentSecond();
  const token = signSandboxJwtForTests({
    scope: "zero",
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
    runId: `run_${randomUUID()}`,
    capabilities: [],
    iat: seconds,
    exp: seconds + 600,
  });

  return { authorization: `Bearer ${token}` };
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

describe("GET /api/zero/org/logo BDD", () => {
  it("reads org logo metadata and enforces auth/token/error boundaries", async () => {
    const client = apiClient();
    const getOrganization = context.mocks.clerk.organizations.getOrganization;

    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(`user_${randomUUID()}`, orgId);
    mockClerkOrganizationLogo({
      orgId,
      imageUrl: "https://img.clerk.test/org-logo.png",
      hasImage: true,
    });

    const logo = await accept(client.get({ headers: authHeaders() }), [200]);

    expect(logo.body).toStrictEqual({
      logoUrl: "https://img.clerk.test/org-logo.png",
      hasImage: true,
    });
    expect(getOrganization).toHaveBeenLastCalledWith({
      organizationId: orgId,
    });

    const orgWithoutLogoId = `org_${randomUUID()}`;
    mocks.clerk.session(`user_${randomUUID()}`, orgWithoutLogoId);
    mockClerkOrganizationLogo({
      orgId: orgWithoutLogoId,
      imageUrl: "",
      hasImage: false,
    });

    const emptyLogo = await accept(
      client.get({ headers: authHeaders() }),
      [200],
    );

    expect(emptyLogo.body).toStrictEqual({
      logoUrl: null,
      hasImage: false,
    });

    getOrganization.mockClear();
    const unauthenticated = await accept(client.get({ headers: {} }), [401]);

    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");
    expect(getOrganization).not.toHaveBeenCalled();

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noActiveOrg = await accept(
      client.get({ headers: authHeaders() }),
      [404],
    );

    expect(noActiveOrg.body.error).toStrictEqual({
      message: "Org not found",
      code: "BAD_REQUEST",
    });
    expect(getOrganization).not.toHaveBeenCalled();

    const missingOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(`user_${randomUUID()}`, missingOrgId);
    getOrganization.mockRejectedValueOnce(clerkNotFoundError());
    const notFound = await accept(
      client.get({ headers: authHeaders() }),
      [404],
    );

    expect(notFound.body.error).toStrictEqual({
      message: "Org not found",
      code: "BAD_REQUEST",
    });
    expect(getOrganization).toHaveBeenLastCalledWith({
      organizationId: missingOrgId,
    });

    const invalidOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(`user_${randomUUID()}`, invalidOrgId);
    getOrganization.mockRejectedValueOnce(clerkBadRequestError());
    const badRequest = await accept(
      client.get({ headers: authHeaders() }),
      [404],
    );

    expect(badRequest.body.error).toStrictEqual({
      message: "Org not found",
      code: "BAD_REQUEST",
    });
    expect(getOrganization).toHaveBeenLastCalledWith({
      organizationId: invalidOrgId,
    });

    getOrganization.mockClear();
    const sandboxToken = await accept(
      client.get({ headers: sandboxAuthHeaders() }),
      [403],
    );

    expect(sandboxToken.body.error).toStrictEqual({
      message: "This endpoint is not available for sandbox tokens",
      code: "FORBIDDEN",
    });
    expect(getOrganization).not.toHaveBeenCalled();
  });
});

describe("POST /api/zero/org/logo BDD", () => {
  it("uploads org logos and enforces auth/admin/file/provider boundaries", async () => {
    const updateOrganizationLogo =
      context.mocks.clerk.organizations.updateOrganizationLogo;

    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(`user_${randomUUID()}`, orgId, "org:admin");
    mockClerkOrganizationLogoUpload({
      orgId,
      imageUrl: "https://img.clerk.test/new-logo.png",
      hasImage: true,
    });

    const file = pngLogoFile();
    const uploaded = await postLogo(logoForm(file), authHeaders());

    expect(uploaded.status).toBe(200);
    await expect(uploaded.json()).resolves.toStrictEqual({
      logoUrl: "https://img.clerk.test/new-logo.png",
      hasImage: true,
    });
    expect(updateOrganizationLogo).toHaveBeenLastCalledWith(orgId, {
      file: expect.objectContaining({
        name: file.name,
        size: file.size,
        type: file.type,
      }),
    });

    const orgWithoutLogoId = `org_${randomUUID()}`;
    mocks.clerk.session(`user_${randomUUID()}`, orgWithoutLogoId, "org:admin");
    mockClerkOrganizationLogoUpload({
      orgId: orgWithoutLogoId,
      imageUrl: "",
      hasImage: false,
    });

    const clearedByProvider = await postLogo(
      logoForm(pngLogoFile()),
      authHeaders(),
    );

    expect(clearedByProvider.status).toBe(200);
    await expect(clearedByProvider.json()).resolves.toStrictEqual({
      logoUrl: null,
      hasImage: false,
    });

    updateOrganizationLogo.mockClear();
    const unauthenticated = await postLogo(logoForm(pngLogoFile()));

    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(updateOrganizationLogo).not.toHaveBeenCalled();

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noActiveOrg = await postLogo(logoForm(pngLogoFile()), authHeaders());

    expect(noActiveOrg.status).toBe(404);
    await expect(noActiveOrg.json()).resolves.toStrictEqual({
      error: { message: "Org not found", code: "BAD_REQUEST" },
    });
    expect(updateOrganizationLogo).not.toHaveBeenCalled();

    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:member",
    );
    const nonAdmin = await postLogo(logoForm(pngLogoFile()), authHeaders());

    expect(nonAdmin.status).toBe(403);
    await expect(nonAdmin.json()).resolves.toStrictEqual({
      error: {
        message: "Only admins can upload the logo",
        code: "BAD_REQUEST",
      },
    });
    expect(updateOrganizationLogo).not.toHaveBeenCalled();

    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:admin",
    );
    const missingFile = await postLogo(new FormData(), authHeaders());

    expect(missingFile.status).toBe(400);
    await expect(missingFile.json()).resolves.toStrictEqual({
      error: { message: "No file provided", code: "BAD_REQUEST" },
    });
    expect(updateOrganizationLogo).not.toHaveBeenCalled();

    const stringFileField = new FormData();
    stringFileField.append("file", "not-a-file");
    const nonFile = await postLogo(stringFileField, authHeaders());

    expect(nonFile.status).toBe(400);
    await expect(nonFile.json()).resolves.toStrictEqual({
      error: { message: "No file provided", code: "BAD_REQUEST" },
    });
    expect(updateOrganizationLogo).not.toHaveBeenCalled();

    const largeFile = new File(
      [new Uint8Array(2 * 1024 * 1024 + 1)],
      "logo.png",
      { type: "image/png" },
    );
    const tooLarge = await postLogo(logoForm(largeFile), authHeaders());

    expect(tooLarge.status).toBe(400);
    await expect(tooLarge.json()).resolves.toStrictEqual({
      error: { message: "File too large (max 2 MB)", code: "BAD_REQUEST" },
    });
    expect(updateOrganizationLogo).not.toHaveBeenCalled();

    const textLogo = new File(["plain"], "logo.txt", { type: "text/plain" });
    const unsupported = await postLogo(logoForm(textLogo), authHeaders());

    expect(unsupported.status).toBe(400);
    await expect(unsupported.json()).resolves.toStrictEqual({
      error: {
        message: "Unsupported file type: text/plain",
        code: "BAD_REQUEST",
      },
    });
    expect(updateOrganizationLogo).not.toHaveBeenCalled();

    const missingProviderOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(
      `user_${randomUUID()}`,
      missingProviderOrgId,
      "org:admin",
    );
    updateOrganizationLogo.mockRejectedValueOnce(clerkNotFoundError());
    const providerNotFound = await postLogo(
      logoForm(pngLogoFile()),
      authHeaders(),
    );

    expect(providerNotFound.status).toBe(404);
    await expect(providerNotFound.json()).resolves.toStrictEqual({
      error: { message: "Org not found", code: "BAD_REQUEST" },
    });
    expect(updateOrganizationLogo).toHaveBeenLastCalledWith(
      missingProviderOrgId,
      expect.any(Object),
    );

    const invalidProviderOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(
      `user_${randomUUID()}`,
      invalidProviderOrgId,
      "org:admin",
    );
    updateOrganizationLogo.mockRejectedValueOnce(clerkBadRequestError());
    const providerBadRequest = await postLogo(
      logoForm(pngLogoFile()),
      authHeaders(),
    );

    expect(providerBadRequest.status).toBe(404);
    await expect(providerBadRequest.json()).resolves.toStrictEqual({
      error: { message: "Org not found", code: "BAD_REQUEST" },
    });
    expect(updateOrganizationLogo).toHaveBeenLastCalledWith(
      invalidProviderOrgId,
      expect.any(Object),
    );

    const forbiddenProviderOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(
      `user_${randomUUID()}`,
      forbiddenProviderOrgId,
      "org:admin",
    );
    updateOrganizationLogo.mockRejectedValueOnce(clerkForbiddenError());
    const providerForbidden = await postLogo(
      logoForm(pngLogoFile()),
      authHeaders(),
    );

    expect(providerForbidden.status).toBe(403);
    await expect(providerForbidden.json()).resolves.toStrictEqual({
      error: { message: "Access denied", code: "BAD_REQUEST" },
    });
    expect(updateOrganizationLogo).toHaveBeenLastCalledWith(
      forbiddenProviderOrgId,
      expect.any(Object),
    );

    updateOrganizationLogo.mockClear();
    const sandboxToken = await postLogo(
      logoForm(pngLogoFile()),
      sandboxAuthHeaders(),
    );

    expect(sandboxToken.status).toBe(403);
    await expect(sandboxToken.json()).resolves.toStrictEqual({
      error: {
        message: "This endpoint is not available for sandbox tokens",
        code: "FORBIDDEN",
      },
    });
    expect(updateOrganizationLogo).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/zero/org/logo BDD", () => {
  it("removes org logos and enforces auth/admin/provider boundaries", async () => {
    const deleteOrganizationLogo =
      context.mocks.clerk.organizations.deleteOrganizationLogo;

    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(`user_${randomUUID()}`, orgId, "org:admin");
    mockClerkOrganizationLogoDelete({
      orgId,
      imageUrl: "https://img.clerk.test/default-logo.png",
      hasImage: true,
    });

    const removed = await deleteLogo(authHeaders());

    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toStrictEqual({
      logoUrl: "https://img.clerk.test/default-logo.png",
      hasImage: true,
    });
    expect(deleteOrganizationLogo).toHaveBeenLastCalledWith(orgId);

    const orgWithoutLogoId = `org_${randomUUID()}`;
    mocks.clerk.session(`user_${randomUUID()}`, orgWithoutLogoId, "org:admin");
    mockClerkOrganizationLogoDelete({
      orgId: orgWithoutLogoId,
      imageUrl: "",
      hasImage: false,
    });

    const clearedByProvider = await deleteLogo(authHeaders());

    expect(clearedByProvider.status).toBe(200);
    await expect(clearedByProvider.json()).resolves.toStrictEqual({
      logoUrl: null,
      hasImage: false,
    });

    deleteOrganizationLogo.mockClear();
    const unauthenticated = await deleteLogo();

    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(deleteOrganizationLogo).not.toHaveBeenCalled();

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noActiveOrg = await deleteLogo(authHeaders());

    expect(noActiveOrg.status).toBe(404);
    await expect(noActiveOrg.json()).resolves.toStrictEqual({
      error: { message: "Org not found", code: "BAD_REQUEST" },
    });
    expect(deleteOrganizationLogo).not.toHaveBeenCalled();

    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:member",
    );
    const nonAdmin = await deleteLogo(authHeaders());

    expect(nonAdmin.status).toBe(403);
    await expect(nonAdmin.json()).resolves.toStrictEqual({
      error: {
        message: "Only admins can remove the logo",
        code: "BAD_REQUEST",
      },
    });
    expect(deleteOrganizationLogo).not.toHaveBeenCalled();

    const missingProviderOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(
      `user_${randomUUID()}`,
      missingProviderOrgId,
      "org:admin",
    );
    deleteOrganizationLogo.mockRejectedValueOnce(clerkNotFoundError());
    const providerNotFound = await deleteLogo(authHeaders());

    expect(providerNotFound.status).toBe(404);
    await expect(providerNotFound.json()).resolves.toStrictEqual({
      error: { message: "Org not found", code: "BAD_REQUEST" },
    });
    expect(deleteOrganizationLogo).toHaveBeenLastCalledWith(
      missingProviderOrgId,
    );

    const invalidProviderOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(
      `user_${randomUUID()}`,
      invalidProviderOrgId,
      "org:admin",
    );
    deleteOrganizationLogo.mockRejectedValueOnce(clerkBadRequestError());
    const providerBadRequest = await deleteLogo(authHeaders());

    expect(providerBadRequest.status).toBe(404);
    await expect(providerBadRequest.json()).resolves.toStrictEqual({
      error: { message: "Org not found", code: "BAD_REQUEST" },
    });
    expect(deleteOrganizationLogo).toHaveBeenLastCalledWith(
      invalidProviderOrgId,
    );

    const forbiddenProviderOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(
      `user_${randomUUID()}`,
      forbiddenProviderOrgId,
      "org:admin",
    );
    deleteOrganizationLogo.mockRejectedValueOnce(clerkForbiddenError());
    const providerForbidden = await deleteLogo(authHeaders());

    expect(providerForbidden.status).toBe(403);
    await expect(providerForbidden.json()).resolves.toStrictEqual({
      error: { message: "Access denied", code: "BAD_REQUEST" },
    });
    expect(deleteOrganizationLogo).toHaveBeenLastCalledWith(
      forbiddenProviderOrgId,
    );

    deleteOrganizationLogo.mockClear();
    const sandboxToken = await deleteLogo(sandboxAuthHeaders());

    expect(sandboxToken.status).toBe(403);
    await expect(sandboxToken.json()).resolves.toStrictEqual({
      error: {
        message: "This endpoint is not available for sandbox tokens",
        code: "FORBIDDEN",
      },
    });
    expect(deleteOrganizationLogo).not.toHaveBeenCalled();
  });
});
