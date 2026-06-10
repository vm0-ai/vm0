import { randomUUID } from "node:crypto";

import { createApp } from "../../../app-factory";
import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the org logo. Clerk owns the organization image, so
// reads/uploads/deletes are external Clerk operations whose result is read back
// from the real response and verified through the Clerk mock. The upload is
// multipart/form-data, which the typed client cannot express, so it is issued as
// a raw request through the app. See `api.bdd.md` (CHAIN-ORG-LOGO).
const context = testContext();

interface LogoState {
  readonly orgId: string;
  readonly imageUrl: string | null;
  readonly hasImage: boolean;
}

function mockClerkGetOrganization(state: LogoState): void {
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: state.orgId,
    imageUrl: state.imageUrl,
    hasImage: state.hasImage,
  });
}

function mockClerkUpdateLogo(state: LogoState): void {
  context.mocks.clerk.organizations.updateOrganizationLogo.mockResolvedValue({
    id: state.orgId,
    imageUrl: state.imageUrl,
    hasImage: state.hasImage,
  });
}

function mockClerkDeleteLogo(state: LogoState): void {
  context.mocks.clerk.organizations.deleteOrganizationLogo.mockResolvedValue({
    id: state.orgId,
    imageUrl: state.imageUrl,
    hasImage: state.hasImage,
  });
}

function clerkError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function pngLogoFile(): File {
  return new File([new Uint8Array([137, 80, 78, 71])], "logo.png", {
    type: "image/png",
  });
}

function logoForm(file: File): FormData {
  const form = new FormData();
  form.append("file", file);
  return form;
}

function postLogo(
  form: FormData,
  headers: HeadersInit = {},
): Promise<Response> {
  return Promise.resolve(
    createApp({ signal: context.signal }).request("/api/zero/org/logo", {
      method: "POST",
      headers,
      body: form,
    }),
  );
}

describe("org logo (API-first BDD)", () => {
  it("reads the org logo, including a cleared image, via Clerk", async () => {
    const api = createBddApi(context);
    const admin = api.actAsAdmin();

    mockClerkGetOrganization({
      orgId: admin.orgId,
      imageUrl: "https://img.clerk.test/org-logo.png",
      hasImage: true,
    });
    const present = await accept(
      api.orgLogo.get({ headers: SESSION_AUTH }),
      [200],
    );
    expect(present.body).toStrictEqual({
      logoUrl: "https://img.clerk.test/org-logo.png",
      hasImage: true,
    });
    expect(
      context.mocks.clerk.organizations.getOrganization,
    ).toHaveBeenCalledWith({ organizationId: admin.orgId });

    mockClerkGetOrganization({
      orgId: admin.orgId,
      imageUrl: null,
      hasImage: false,
    });
    const cleared = await accept(
      api.orgLogo.get({ headers: SESSION_AUTH }),
      [200],
    );
    expect(cleared.body).toStrictEqual({ logoUrl: null, hasImage: false });
  });

  it("rejects unauthorized reads and maps Clerk failures to 404", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    const unauth = await accept(api.orgLogo.get({ headers: {} }), [401]);
    expect(unauth.body.error.code).toBe("UNAUTHORIZED");

    // No active organization.
    api.actAsNoOrg();
    const noOrg = await accept(
      api.orgLogo.get({ headers: SESSION_AUTH }),
      [404],
    );
    expect(noOrg.body.error).toStrictEqual({
      message: "Org not found",
      code: "BAD_REQUEST",
    });

    // Zero (sandbox) tokens are not allowed on this endpoint.
    const zero = await accept(
      api.orgLogo.get({ headers: api.zeroAuth([]) }),
      [403],
    );
    expect(zero.body.error).toStrictEqual({
      message: "This endpoint is not available for sandbox tokens",
      code: "FORBIDDEN",
    });

    // None of the rejected reads above reached Clerk.
    expect(
      context.mocks.clerk.organizations.getOrganization,
    ).not.toHaveBeenCalled();

    // Clerk not-found and bad-request both surface as 404.
    api.actAsAdmin();
    context.mocks.clerk.organizations.getOrganization.mockRejectedValue(
      clerkError("NotFoundError", "Organization not found"),
    );
    const notFound = await accept(
      api.orgLogo.get({ headers: SESSION_AUTH }),
      [404],
    );
    expect(notFound.body.error.message).toBe("Org not found");
    context.mocks.clerk.organizations.getOrganization.mockRejectedValue(
      clerkError("BadRequestError", "Invalid organization"),
    );
    await accept(api.orgLogo.get({ headers: SESSION_AUTH }), [404]);
  });

  it("uploads a logo and reflects a cleared image", async () => {
    const api = createBddApi(context);
    const admin = api.actAsAdmin();
    mockClerkUpdateLogo({
      orgId: admin.orgId,
      imageUrl: "https://img.clerk.test/new-logo.png",
      hasImage: true,
    });

    const file = pngLogoFile();
    const uploaded = await postLogo(logoForm(file), SESSION_AUTH);
    expect(uploaded.status).toBe(200);
    await expect(uploaded.json()).resolves.toStrictEqual({
      logoUrl: "https://img.clerk.test/new-logo.png",
      hasImage: true,
    });
    expect(
      context.mocks.clerk.organizations.updateOrganizationLogo,
    ).toHaveBeenCalledWith(admin.orgId, {
      file: expect.objectContaining({
        name: file.name,
        size: file.size,
        type: file.type,
      }),
    });

    mockClerkUpdateLogo({ orgId: admin.orgId, imageUrl: "", hasImage: false });
    const cleared = await postLogo(logoForm(pngLogoFile()), SESSION_AUTH);
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toStrictEqual({
      logoUrl: null,
      hasImage: false,
    });
  });

  it("validates the uploaded file", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();

    // No file field.
    const noFile = await postLogo(new FormData(), SESSION_AUTH);
    expect(noFile.status).toBe(400);
    await expect(noFile.json()).resolves.toStrictEqual({
      error: { message: "No file provided", code: "BAD_REQUEST" },
    });

    // The file field is a string, not a file.
    const notAFileForm = new FormData();
    notAFileForm.append("file", "not-a-file");
    const notAFile = await postLogo(notAFileForm, SESSION_AUTH);
    expect(notAFile.status).toBe(400);
    await expect(notAFile.json()).resolves.toMatchObject({
      error: { message: "No file provided" },
    });

    // The file exceeds the 2 MB limit.
    const tooLarge = await postLogo(
      logoForm(
        new File([new Uint8Array(2 * 1024 * 1024 + 1)], "logo.png", {
          type: "image/png",
        }),
      ),
      SESSION_AUTH,
    );
    expect(tooLarge.status).toBe(400);
    await expect(tooLarge.json()).resolves.toStrictEqual({
      error: { message: "File too large (max 2 MB)", code: "BAD_REQUEST" },
    });

    // The file type is unsupported.
    const unsupported = await postLogo(
      logoForm(new File(["plain"], "logo.txt", { type: "text/plain" })),
      SESSION_AUTH,
    );
    expect(unsupported.status).toBe(400);
    await expect(unsupported.json()).resolves.toStrictEqual({
      error: {
        message: "Unsupported file type: text/plain",
        code: "BAD_REQUEST",
      },
    });

    expect(
      context.mocks.clerk.organizations.updateOrganizationLogo,
    ).not.toHaveBeenCalled();
  });

  it("enforces auth and role on upload and maps Clerk failures", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    const unauth = await postLogo(logoForm(pngLogoFile()));
    expect(unauth.status).toBe(401);

    // No active organization.
    api.actAsNoOrg();
    const noOrg = await postLogo(logoForm(pngLogoFile()), SESSION_AUTH);
    expect(noOrg.status).toBe(404);

    // Non-admin member.
    api.actAsMember({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    });
    const member = await postLogo(logoForm(pngLogoFile()), SESSION_AUTH);
    expect(member.status).toBe(403);

    // Zero tokens are not allowed.
    const zero = await postLogo(logoForm(pngLogoFile()), api.zeroAuth([]));
    expect(zero.status).toBe(403);

    // Clerk not-found / bad-request → 404, forbidden → 403.
    api.actAsAdmin();
    context.mocks.clerk.organizations.updateOrganizationLogo.mockRejectedValue(
      clerkError("NotFoundError", "Organization not found"),
    );
    expect((await postLogo(logoForm(pngLogoFile()), SESSION_AUTH)).status).toBe(
      404,
    );
    context.mocks.clerk.organizations.updateOrganizationLogo.mockRejectedValue(
      clerkError("BadRequestError", "Invalid organization"),
    );
    expect((await postLogo(logoForm(pngLogoFile()), SESSION_AUTH)).status).toBe(
      404,
    );
    context.mocks.clerk.organizations.updateOrganizationLogo.mockRejectedValue(
      clerkError("ForbiddenError", "Forbidden"),
    );
    expect((await postLogo(logoForm(pngLogoFile()), SESSION_AUTH)).status).toBe(
      403,
    );
  });

  it("removes the org logo, including a cleared image", async () => {
    const api = createBddApi(context);
    const admin = api.actAsAdmin();
    mockClerkDeleteLogo({
      orgId: admin.orgId,
      imageUrl: "https://img.clerk.test/default-logo.png",
      hasImage: true,
    });

    const removed = await accept(
      api.orgLogo.delete({ headers: SESSION_AUTH }),
      [200],
    );
    expect(removed.body).toStrictEqual({
      logoUrl: "https://img.clerk.test/default-logo.png",
      hasImage: true,
    });
    expect(
      context.mocks.clerk.organizations.deleteOrganizationLogo,
    ).toHaveBeenCalledWith(admin.orgId);

    mockClerkDeleteLogo({ orgId: admin.orgId, imageUrl: "", hasImage: false });
    const cleared = await accept(
      api.orgLogo.delete({ headers: SESSION_AUTH }),
      [200],
    );
    expect(cleared.body).toStrictEqual({ logoUrl: null, hasImage: false });
  });

  it("enforces auth and role on delete and maps Clerk failures", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    await accept(api.orgLogo.delete({ headers: {} }), [401]);

    // No active organization.
    api.actAsNoOrg();
    await accept(api.orgLogo.delete({ headers: SESSION_AUTH }), [404]);

    // Non-admin member.
    api.actAsMember({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    });
    await accept(api.orgLogo.delete({ headers: SESSION_AUTH }), [403]);

    // Clerk not-found / bad-request → 404, forbidden → 403.
    api.actAsAdmin();
    context.mocks.clerk.organizations.deleteOrganizationLogo.mockRejectedValue(
      clerkError("NotFoundError", "Organization not found"),
    );
    await accept(api.orgLogo.delete({ headers: SESSION_AUTH }), [404]);
    context.mocks.clerk.organizations.deleteOrganizationLogo.mockRejectedValue(
      clerkError("BadRequestError", "Invalid organization"),
    );
    await accept(api.orgLogo.delete({ headers: SESSION_AUTH }), [404]);
    context.mocks.clerk.organizations.deleteOrganizationLogo.mockRejectedValue(
      clerkError("ForbiddenError", "Forbidden"),
    );
    await accept(api.orgLogo.delete({ headers: SESSION_AUTH }), [403]);
  });
});
