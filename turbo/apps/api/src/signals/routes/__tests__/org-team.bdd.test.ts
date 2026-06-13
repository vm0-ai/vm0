import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-helpers";
import {
  createAuthOrgAgentsBddApi,
  type ApiTestUser,
} from "./helpers/api-bdd-auth-org";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";
import { expectApiError } from "./helpers/api-bdd";

/*
ORG-01/02/03, TEAM, and AGENT-02 chains replacing the legacy zero-org*,
zero-team, zero-default-agent, and zero-onboarding-setup route tests:
- Org/member/Slack-connection DB row asserts are replaced by follow-up
  GET /org, listMembers, listOrgs, Slack connect-status reads, and response
  messages; onboarding row asserts by onboarding status, agents list, and
  enabled-connector reads.
- Boundary-call asserts are kept only where contract-critical: the Clerk
  `updateOrganizationLogo(orgId, {file})` shape, the `updateOrganization`
  slug-retry call sequences, and the membership_requests REST call-count 0
  for non-admin callers (security guarantee).
- Per-route 401 / no-org / sandbox-token-rejection duplicates are merged:
  one representative per distinct inner-handler statement, plus two
  representative sandbox rejections in the run-scoped token chain.
- "zero token without billing:read -> 403" is dropped: `generateZeroToken`
  grants billing:read unconditionally, so the case is not API-constructible
  (zero-maps precedent).
*/

const context = testContext();
const api = createAuthOrgAgentsBddApi(context);

function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 10);
}

function slug(prefix: string): string {
  return `${prefix}-${shortId()}`;
}

function orgIdOf(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected actor to have an organization");
  }
  return actor.orgId;
}

async function onboardAdmin(
  admin: ApiTestUser,
  options: {
    readonly displayName?: string;
    readonly slug?: string;
    readonly name?: string;
  } = {},
): Promise<string> {
  const orgState: { slug?: string; name?: string } = {};
  if (options.slug !== undefined) {
    orgState.slug = options.slug;
  }
  if (options.name !== undefined) {
    orgState.name = options.name;
  }
  api.mockClerkOrg(admin, orgState);
  const setup = await api.setupOnboarding(admin, {
    displayName: options.displayName ?? "BDD Org Team Agent",
    workspaceName: options.name ?? "BDD Org Team Workspace",
    sound: "calm",
    timezone: "UTC",
    role: "engineering",
  });
  if (setup.status !== 200 && setup.status !== 409) {
    throw new Error(
      `Expected onboarding setup to succeed, got ${setup.status}`,
    );
  }
  return setup.body.agentId;
}

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a plain object");
  }
  return value as Record<string, unknown>;
}

function slugConflictError(): Error {
  return Object.assign(new Error("Unprocessable Entity"), {
    status: 422,
    errors: [
      {
        code: "form_identifier_exists",
        message: "That slug is already in use",
        meta: { paramName: "slug" },
      },
    ],
  });
}

function nonSlugClerkError(): Error {
  return Object.assign(new Error("Unprocessable Entity"), {
    status: 422,
    errors: [
      {
        code: "form_param_value_invalid",
        message: "Name is invalid",
        meta: { paramName: "name" },
      },
    ],
  });
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

describe("ORG-01: org logo lifecycle through the Clerk boundary", () => {
  it("serves, uploads, and removes the org logo across auth, validation, and clerk error arms [ORG-LOGO-A]", async () => {
    const admin = api.user();
    const member = api.user({ orgId: admin.orgId, orgRole: "org:member" });
    const noOrg = api.user({ orgId: null });
    const orgId = orgIdOf(admin);

    // GET happy path + ""→null arm. First test in the file: install the
    // Clerk logo boundary explicitly before any call.
    api.mockClerkOrgLogo("get", {
      imageUrl: "https://img.clerk.test/org-logo.png",
      hasImage: true,
    });
    const logo = await api.requestReadOrgLogo(admin, [200]);
    expect(logo.body).toStrictEqual({
      logoUrl: "https://img.clerk.test/org-logo.png",
      hasImage: true,
    });
    expect(
      context.mocks.clerk.organizations.getOrganization,
    ).toHaveBeenCalledWith({ organizationId: orgId });

    api.mockClerkOrgLogo("get", { imageUrl: "", hasImage: false });
    const clearedLogo = await api.requestReadOrgLogo(admin, [200]);
    expect(clearedLogo.body).toStrictEqual({ logoUrl: null, hasImage: false });

    // GET auth arms.
    const unauthenticatedGet = await api.requestReadOrgLogo(null, [401]);
    expectApiError(unauthenticatedGet.body);
    expect(unauthenticatedGet.body.error.code).toBe("UNAUTHORIZED");
    const noOrgGet = await api.requestReadOrgLogo(noOrg, [404]);
    expect(noOrgGet.body).toStrictEqual({
      error: { message: "Org not found", code: "BAD_REQUEST" },
    });

    // GET Clerk lookup failures map to the same 404.
    api.mockClerkLogoError("get", "NotFoundError");
    const getNotFound = await api.requestReadOrgLogo(admin, [404]);
    expect(getNotFound.body).toStrictEqual({
      error: { message: "Org not found", code: "BAD_REQUEST" },
    });
    api.mockClerkLogoError("get", "BadRequestError");
    const getBadRequest = await api.requestReadOrgLogo(admin, [404]);
    expect(getBadRequest.body).toStrictEqual({
      error: { message: "Org not found", code: "BAD_REQUEST" },
    });

    // POST happy path asserts the Clerk boundary call shape.
    api.mockClerkOrgLogo("upload", {
      imageUrl: "https://img.clerk.test/new-logo.png",
      hasImage: true,
    });
    const file = pngLogoFile();
    const uploaded = await api.requestUploadOrgLogo(
      admin,
      logoForm(file),
      [200],
    );
    expect(uploaded.body).toStrictEqual({
      logoUrl: "https://img.clerk.test/new-logo.png",
      hasImage: true,
    });
    expect(
      context.mocks.clerk.organizations.updateOrganizationLogo,
    ).toHaveBeenCalledWith(orgId, {
      file: expect.objectContaining({
        name: file.name,
        size: file.size,
        type: file.type,
      }),
    });
    api.mockClerkOrgLogo("upload", { imageUrl: "", hasImage: false });
    const uploadedCleared = await api.requestUploadOrgLogo(
      admin,
      logoForm(pngLogoFile()),
      [200],
    );
    expect(uploadedCleared.body).toStrictEqual({
      logoUrl: null,
      hasImage: false,
    });

    // POST auth arms.
    const unauthenticatedPost = await api.requestUploadOrgLogo(
      null,
      logoForm(pngLogoFile()),
      [401],
    );
    expect(unauthenticatedPost.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    const noOrgPost = await api.requestUploadOrgLogo(
      noOrg,
      logoForm(pngLogoFile()),
      [404],
    );
    expect(noOrgPost.body).toStrictEqual({
      error: { message: "Org not found", code: "BAD_REQUEST" },
    });
    const memberPost = await api.requestUploadOrgLogo(
      member,
      logoForm(pngLogoFile()),
      [403],
    );
    expect(memberPost.body).toStrictEqual({
      error: {
        message: "Only admins can upload the logo",
        code: "BAD_REQUEST",
      },
    });

    // POST file validation arms.
    const emptyForm = await api.requestUploadOrgLogo(
      admin,
      new FormData(),
      [400],
    );
    expect(emptyForm.body).toStrictEqual({
      error: { message: "No file provided", code: "BAD_REQUEST" },
    });
    const stringForm = new FormData();
    stringForm.append("file", "not-a-file");
    const stringField = await api.requestUploadOrgLogo(
      admin,
      stringForm,
      [400],
    );
    expect(stringField.body).toStrictEqual({
      error: { message: "No file provided", code: "BAD_REQUEST" },
    });
    const oversized = new File(
      [new Uint8Array(2 * 1024 * 1024 + 1)],
      "logo.png",
      { type: "image/png" },
    );
    const tooLarge = await api.requestUploadOrgLogo(
      admin,
      logoForm(oversized),
      [400],
    );
    expect(tooLarge.body).toStrictEqual({
      error: { message: "File too large (max 2 MB)", code: "BAD_REQUEST" },
    });
    const textFile = new File(["plain"], "logo.txt", { type: "text/plain" });
    const unsupported = await api.requestUploadOrgLogo(
      admin,
      logoForm(textFile),
      [400],
    );
    expect(unsupported.body).toStrictEqual({
      error: {
        message: "Unsupported file type: text/plain",
        code: "BAD_REQUEST",
      },
    });

    // POST Clerk failures.
    api.mockClerkLogoError("upload", "NotFoundError");
    const postNotFound = await api.requestUploadOrgLogo(
      admin,
      logoForm(pngLogoFile()),
      [404],
    );
    expect(postNotFound.body).toStrictEqual({
      error: { message: "Org not found", code: "BAD_REQUEST" },
    });
    api.mockClerkLogoError("upload", "BadRequestError");
    const postBadRequest = await api.requestUploadOrgLogo(
      admin,
      logoForm(pngLogoFile()),
      [404],
    );
    expect(postBadRequest.body).toStrictEqual({
      error: { message: "Org not found", code: "BAD_REQUEST" },
    });
    api.mockClerkLogoError("upload", "ForbiddenError");
    const postForbidden = await api.requestUploadOrgLogo(
      admin,
      logoForm(pngLogoFile()),
      [403],
    );
    expect(postForbidden.body).toStrictEqual({
      error: { message: "Access denied", code: "BAD_REQUEST" },
    });

    // DELETE happy path + ""→null arm.
    api.mockClerkOrgLogo("delete", {
      imageUrl: "https://img.clerk.test/default-logo.png",
      hasImage: true,
    });
    const removed = await api.requestDeleteOrgLogo(admin, [200]);
    expect(removed.body).toStrictEqual({
      logoUrl: "https://img.clerk.test/default-logo.png",
      hasImage: true,
    });
    expect(
      context.mocks.clerk.organizations.deleteOrganizationLogo,
    ).toHaveBeenCalledWith(orgId);
    api.mockClerkOrgLogo("delete", { imageUrl: "", hasImage: false });
    const removedCleared = await api.requestDeleteOrgLogo(admin, [200]);
    expect(removedCleared.body).toStrictEqual({
      logoUrl: null,
      hasImage: false,
    });

    // DELETE auth arms.
    const unauthenticatedDelete = await api.requestDeleteOrgLogo(null, [401]);
    expectApiError(unauthenticatedDelete.body);
    expect(unauthenticatedDelete.body.error.code).toBe("UNAUTHORIZED");
    const noOrgDelete = await api.requestDeleteOrgLogo(noOrg, [404]);
    expect(noOrgDelete.body).toStrictEqual({
      error: { message: "Org not found", code: "BAD_REQUEST" },
    });
    const memberDelete = await api.requestDeleteOrgLogo(member, [403]);
    expect(memberDelete.body).toStrictEqual({
      error: {
        message: "Only admins can remove the logo",
        code: "BAD_REQUEST",
      },
    });

    // DELETE Clerk failures.
    api.mockClerkLogoError("delete", "NotFoundError");
    const deleteNotFound = await api.requestDeleteOrgLogo(admin, [404]);
    expect(deleteNotFound.body).toStrictEqual({
      error: { message: "Org not found", code: "BAD_REQUEST" },
    });
    api.mockClerkLogoError("delete", "BadRequestError");
    const deleteBadRequest = await api.requestDeleteOrgLogo(admin, [404]);
    expect(deleteBadRequest.body).toStrictEqual({
      error: { message: "Org not found", code: "BAD_REQUEST" },
    });
    api.mockClerkLogoError("delete", "ForbiddenError");
    const deleteForbidden = await api.requestDeleteOrgLogo(admin, [403]);
    expect(deleteForbidden.body).toStrictEqual({
      error: { message: "Access denied", code: "BAD_REQUEST" },
    });
  });
});

describe("ORG-01: org update and delete error matrix", () => {
  it("maps no-org, slug-force, reserved, conflict, admin-leave, and delete failure arms [ORG-UPDATE-B]", async () => {
    const noOrg = api.user({ orgId: null });
    const noOrgUpdate = await api.requestUpdateOrg(
      noOrg,
      { force: false },
      [400],
    );
    expectApiError(noOrgUpdate.body);
    expect(noOrgUpdate.body.error.message).toBe(
      "No org configured. Set your org with: zero org set <slug>",
    );

    const admin = api.user();
    const baseSlug = slug("bdd-r5-org");
    api.acceptAgentStorageWrites();
    await onboardAdmin(admin, { slug: baseSlug, name: "BDD R5 Org" });
    api.mockClerkOrg(admin, { slug: baseSlug, name: "BDD R5 Org" });

    context.mocks.clerk.organizations.updateOrganization.mockClear();
    const unforced = await api.requestUpdateOrg(
      admin,
      { slug: slug("bdd-r5-next"), force: false },
      [400],
    );
    expectApiError(unforced.body);
    expect(unforced.body.error.message).toBe(
      "Changing org slug may break existing references. Use --force to confirm.",
    );
    expect(
      context.mocks.clerk.organizations.updateOrganization,
    ).not.toHaveBeenCalled();

    const reserved = await api.requestUpdateOrg(
      admin,
      { slug: "vm0-team", force: true },
      [400],
    );
    expectApiError(reserved.body);
    expect(reserved.body.error.message).toBe("Org slug is reserved");
    expect(
      context.mocks.clerk.organizations.updateOrganization,
    ).not.toHaveBeenCalled();

    // A second org caches the taken slug through its own org read; renaming
    // the first org onto it must conflict.
    const otherAdmin = api.user();
    const takenSlug = slug("bdd-r5-taken");
    api.mockClerkOrg(otherAdmin, { slug: takenSlug, name: "BDD Taken Org" });
    const otherOrg = await api.readOrg(otherAdmin);
    expect(otherOrg.slug).toBe(takenSlug);
    api.mockClerkOrg(admin, { slug: baseSlug, name: "BDD R5 Org" });
    const conflicted = await api.requestUpdateOrg(
      admin,
      { slug: takenSlug, force: true },
      [409],
    );
    expectApiError(conflicted.body);
    expect(conflicted.body.error.message).toBe(
      `Org "${takenSlug}" already exists`,
    );

    // No-op update returns the current org without touching Clerk.
    context.mocks.clerk.organizations.updateOrganization.mockClear();
    const noop = await api.requestUpdateOrg(admin, { force: false }, [200]);
    expect(noop.body).toMatchObject({
      id: admin.orgId,
      slug: baseSlug,
      name: "BDD R5 Org",
    });
    expect(
      context.mocks.clerk.organizations.updateOrganization,
    ).not.toHaveBeenCalled();

    const adminLeave = await api.requestLeaveOrg(admin, [403]);
    expectApiError(adminLeave.body);
    expect(adminLeave.body.error.message).toBe(
      "Admins cannot leave the organization",
    );

    // Delete failure arms: member caller, slug mismatch, invalid body, and
    // an org whose identity is gone on the Clerk side.
    const memberCaller = api.user({
      orgId: admin.orgId,
      orgRole: "org:member",
    });
    const memberDelete = await api.requestDeleteOrg(
      memberCaller,
      baseSlug,
      [403],
    );
    expectApiError(memberDelete.body);
    expect(memberDelete.body.error.message).toBe(
      "Only admins can delete the organization",
    );

    const wrongSlug = await api.requestDeleteOrg(
      admin,
      slug("bdd-r5-wrong"),
      [400],
    );
    expectApiError(wrongSlug.body);
    expect(wrongSlug.body.error.message).toBe(
      "Organization name does not match",
    );

    const rawDelete = await api.requestRawJson(
      admin,
      "/api/zero/org/delete",
      "POST",
      {},
      [400],
    );
    expect(rawDelete.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    const stillThere = await api.readOrg(admin);
    expect(stillThere.slug).toBe(baseSlug);

    const orphanAdmin = api.user();
    context.mocks.clerk.organizations.getOrganization.mockRejectedValue({
      statusCode: 404,
    });
    const missingIdentity = await api.requestDeleteOrg(
      orphanAdmin,
      slug("bdd-r5-missing"),
      [404],
    );
    expect(missingIdentity.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });
  });
});

describe("ORG-02: membership admin matrix", () => {
  it("enforces role, self, unknown-target, invalid-body, and clerk-failure arms across member routes [ORG-MEMBERS-C]", async () => {
    const admin = api.user();
    const orgId = orgIdOf(admin);
    const member = api.user({
      orgId,
      orgRole: "org:member",
      email: `member-${shortId()}@example.test`,
    });
    const secondAdmin = api.user({
      orgId,
      email: `second-admin-${shortId()}@example.test`,
    });
    const requester = api.user({
      orgId,
      orgRole: "org:member",
      email: `requester-${shortId()}@example.test`,
    });
    const ghostEmail = `ghost-${shortId()}@example.test`;
    api.acceptAgentStorageWrites();
    await onboardAdmin(admin, { slug: slug("bdd-r5-members") });

    const orgMembers = [
      { actor: admin, role: "org:admin" as const },
      { actor: member, role: "org:member" as const },
    ];
    api.mockClerkOrg(admin, { members: orgMembers });

    // updateRole arms.
    const memberRole = await api.requestUpdateMemberRole(
      member,
      { email: admin.email, role: "member" },
      [403],
    );
    expect(memberRole.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
    const unknownRole = await api.requestUpdateMemberRole(
      admin,
      { email: ghostEmail, role: "admin" },
      [404],
    );
    expect(unknownRole.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });
    const soloDemote = await api.requestUpdateMemberRole(
      admin,
      { email: admin.email, role: "member" },
      [400],
    );
    expect(soloDemote.body).toStrictEqual({
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    });
    api.mockClerkOrg(admin, {
      members: [
        { actor: admin, role: "org:admin" },
        { actor: secondAdmin, role: "org:admin" },
        { actor: member, role: "org:member" },
      ],
    });
    const demoted = await api.updateMemberRole(admin, {
      email: admin.email,
      role: "member",
    });
    expect(demoted).toStrictEqual({
      message: `Updated role for ${admin.email}`,
    });
    const invalidRoleBody = await api.requestUpdateMemberRole(
      admin,
      { email: "not-an-email", role: "member" },
      [400],
    );
    expectApiError(invalidRoleBody.body);
    expect(invalidRoleBody.body.error.code).toBe("BAD_REQUEST");

    // removeMember arms.
    const memberRemove = await api.requestRemoveMember(
      member,
      { email: admin.email },
      [403],
    );
    expect(memberRemove.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
    const unknownRemove = await api.requestRemoveMember(
      admin,
      { email: ghostEmail },
      [404],
    );
    expect(unknownRemove.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });
    const selfRemove = await api.requestRemoveMember(
      admin,
      { email: admin.email },
      [400],
    );
    expect(selfRemove.body).toStrictEqual({
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    });
    const stranger = api.user({
      email: `stranger-${shortId()}@example.test`,
    });
    api.mockClerkUsers([admin, secondAdmin, member, stranger]);
    const notMember = await api.requestRemoveMember(
      admin,
      { email: stranger.email },
      [404],
    );
    expect(notMember.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });
    const invalidRemoveBody = await api.requestRemoveMember(
      admin,
      { email: "not-an-email" },
      [400],
    );
    expectApiError(invalidRemoveBody.body);
    expect(invalidRemoveBody.body.error.code).toBe("BAD_REQUEST");

    // invite arms.
    const memberRevoke = await api.requestRevokeInvitation(
      member,
      `inv_${shortId()}`,
      [403],
    );
    expect(memberRevoke.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
    const invalidInvite = await api.requestInviteMember(
      admin,
      { email: "not-an-email", role: "member" },
      [400],
    );
    expectApiError(invalidInvite.body);
    expect(invalidInvite.body.error.code).toBe("BAD_REQUEST");
    const rawRevoke = await api.requestRawJson(
      admin,
      "/api/zero/org/invite",
      "DELETE",
      {},
      [400],
    );
    expect(rawRevoke.body).toMatchObject({ error: { code: "BAD_REQUEST" } });

    // membership-request arms with REST call counters: non-admin callers and
    // invalid bodies must never reach the Clerk REST API.
    const requestId = `req_${shortId()}`;
    const failingActions = api.mockClerkMembershipRequestHandlers(orgId, {
      acceptStatus: 404,
      rejectStatus: 404,
    });
    const memberAccept = await api.requestAcceptMembershipRequest(
      member,
      { requestId },
      [403],
    );
    expect(memberAccept.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
    const memberReject = await api.requestRejectMembershipRequest(
      member,
      { requestId },
      [403],
    );
    expect(memberReject.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
    expect(failingActions.acceptCalls()).toBe(0);
    expect(failingActions.rejectCalls()).toBe(0);

    const failedAccept = await api.requestAcceptMembershipRequest(
      admin,
      { requestId },
      [400],
    );
    expect(failedAccept.body).toStrictEqual({
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    });
    const failedReject = await api.requestRejectMembershipRequest(
      admin,
      { requestId },
      [400],
    );
    expect(failedReject.body).toStrictEqual({
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    });
    expect(failingActions.acceptCalls()).toBe(1);
    expect(failingActions.rejectCalls()).toBe(1);

    const rawAccept = await api.requestRawJson(
      admin,
      "/api/zero/org/membership-requests",
      "POST",
      {},
      [400],
    );
    expect(rawAccept.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    const rawReject = await api.requestRawJson(
      admin,
      "/api/zero/org/membership-requests",
      "DELETE",
      {},
      [400],
    );
    expect(rawReject.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(failingActions.acceptCalls()).toBe(1);
    expect(failingActions.rejectCalls()).toBe(1);

    // listMembers tolerates a Clerk org without the membership_requests
    // feature (REST 404 → empty list).
    const inviteId = `inv_${shortId()}`;
    api.mockClerkOrg(admin, {
      members: orgMembers,
      pendingInvitations: [
        { id: inviteId, email: `invitee-${shortId()}@example.test` },
      ],
      membershipRequests: [{ id: requestId, actor: requester }],
    });
    const featureDisabled = api.mockClerkMembershipRequestHandlers(orgId, {
      listStatus: 404,
    });
    const adminList = await api.listMembers(admin);
    expect(adminList.role).toBe("admin");
    expect(adminList.pendingInvitations?.[0]?.id).toBe(inviteId);
    expect(adminList.membershipRequests).toStrictEqual([]);
    expect(featureDisabled.listCalls()).toBe(1);

    // Members never see invitations or membership requests, and the REST
    // membership_requests endpoint is never called for them.
    const memberView = api.mockClerkMembershipRequestHandlers(orgId, {
      requests: [{ id: requestId, actor: requester }],
    });
    const memberList = await api.listMembers(member);
    expect(memberList.role).toBe("member");
    expect(memberList.pendingInvitations).toStrictEqual([]);
    expect(memberList.membershipRequests).toStrictEqual([]);
    expect(memberView.listCalls()).toBe(0);
  });
});

describe("ORG-02: member cleanup detaches Slack connections", () => {
  it("disconnects slack-linked members on leave, removal, and org deletion [ORG-SLACK-D]", async () => {
    const integrations = createBddIntegrationApi(context);
    const admin = api.user();
    const member = api.user({
      orgId: admin.orgId,
      orgRole: "org:member",
      email: `member-${shortId()}@example.test`,
    });
    const secondMember = api.user({
      orgId: admin.orgId,
      orgRole: "org:member",
      email: `member2-${shortId()}@example.test`,
    });
    api.acceptAgentStorageWrites();
    integrations.configureSlackAppMocks();
    await onboardAdmin(admin, { slug: slug("bdd-r5-slack") });
    const install = await integrations.installSlackWorkspace(admin);

    await integrations.connectSlackUser(member, {
      workspaceId: install.teamId,
      slackUserId: `U_LEAVE_${shortId().toUpperCase()}`,
    });
    const connected = await integrations.requestSlackConnectStatus(
      member,
      [200],
    );
    expect(connected.body).toMatchObject({ isConnected: true });

    api.mockClerkOrg(member, {
      members: [
        { actor: admin, role: "org:admin" },
        { actor: member, role: "org:member" },
      ],
    });
    await expect(api.leaveOrg(member)).resolves.toStrictEqual({
      message: "Left org",
    });
    const afterLeave = await integrations.requestSlackConnectStatus(
      member,
      [200],
    );
    expect(afterLeave.body).toMatchObject({ isConnected: false });

    await integrations.connectSlackUser(secondMember, {
      workspaceId: install.teamId,
      slackUserId: `U_REMOVE_${shortId().toUpperCase()}`,
    });
    const secondConnected = await integrations.requestSlackConnectStatus(
      secondMember,
      [200],
    );
    expect(secondConnected.body).toMatchObject({ isConnected: true });
    api.mockClerkOrg(admin, {
      members: [
        { actor: admin, role: "org:admin" },
        { actor: secondMember, role: "org:member" },
      ],
    });
    await expect(
      api.removeMember(admin, { email: secondMember.email }),
    ).resolves.toStrictEqual({
      message: `Removed ${secondMember.email} from org`,
    });
    const afterRemove = await integrations.requestSlackConnectStatus(
      secondMember,
      [200],
    );
    expect(afterRemove.body).toMatchObject({ isConnected: false });

    // Deleting an org sweeps every member's Slack connection.
    const secondAdmin = api.user();
    const thirdMember = api.user({
      orgId: secondAdmin.orgId,
      orgRole: "org:member",
      email: `member3-${shortId()}@example.test`,
    });
    const secondInstall = await integrations.installSlackWorkspace(secondAdmin);
    await integrations.connectSlackUser(thirdMember, {
      workspaceId: secondInstall.teamId,
      slackUserId: `U_DELETE_${shortId().toUpperCase()}`,
    });
    const thirdConnected = await integrations.requestSlackConnectStatus(
      thirdMember,
      [200],
    );
    expect(thirdConnected.body).toMatchObject({ isConnected: true });
    const deleteSlug = slug("bdd-r5-del");
    api.mockClerkOrg(secondAdmin, {
      slug: deleteSlug,
      members: [
        { actor: secondAdmin, role: "org:admin" },
        { actor: thirdMember, role: "org:member" },
      ],
    });
    await expect(api.deleteOrg(secondAdmin, deleteSlug)).resolves.toStrictEqual(
      { message: "Organization deleted" },
    );
    const afterDelete = await integrations.requestSlackConnectStatus(
      thirdMember,
      [200],
    );
    expect(afterDelete.body).toMatchObject({ isConnected: false });
  });
});

describe("ORG-01/AGENT-02: team listing and default-agent recovery", () => {
  it("lists org-visible agents only and restores a deleted default agent [TEAM-E]", async () => {
    const unauthenticated = await api.requestListTeam(null, [401]);
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const noOrg = api.user({ orgId: null });
    const noOrgTeam = await api.requestListTeam(noOrg, [403]);
    expect(noOrgTeam.body).toStrictEqual({
      error: {
        message: "No active organization. Please select an org.",
        code: "FORBIDDEN",
      },
    });

    const crossOrgAdmin = api.user();
    await expect(api.listTeam(crossOrgAdmin)).resolves.toStrictEqual([]);

    const admin = api.user();
    const peerAdmin = api.user({
      orgId: admin.orgId,
      email: `peer-admin-${shortId()}@example.test`,
    });
    api.acceptAgentStorageWrites();
    const defaultAgentId = await onboardAdmin(admin, {
      slug: slug("bdd-r5-team"),
      displayName: "BDD Team Default",
    });

    const team = await api.listTeam(admin);
    const defaultEntry = team.find((entry) => {
      return entry.id === defaultAgentId;
    });
    expect(defaultEntry).toMatchObject({
      id: defaultAgentId,
      ownerId: admin.userId,
      displayName: "BDD Team Default",
      description: null,
      sound: "calm",
      avatarUrl: null,
      customSkills: [],
      visibility: "public",
    });
    expect(defaultEntry?.headVersionId).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof defaultEntry?.updatedAt).toBe("string");

    // A compose without a zero-agent row never appears in the team list.
    const composeName = slug("bdd-r5-compose");
    const compose = await api.createCompose(
      admin,
      api.composeContent(composeName),
    );
    const teamAfterCompose = await api.listTeam(admin);
    expect(
      teamAfterCompose.map((entry) => {
        return entry.id;
      }),
    ).not.toContain(compose.composeId);

    // Private agents are visible to their owner only; public agents to the
    // whole org; nothing leaks across orgs.
    const ownPrivate = await api.createAgent(admin, {
      displayName: "BDD Own Private",
      visibility: "private",
    });
    const peerPrivate = await api.createAgent(peerAdmin, {
      displayName: "BDD Peer Private",
      visibility: "private",
    });
    const adminTeamIds = (await api.listTeam(admin)).map((entry) => {
      return entry.id;
    });
    expect(adminTeamIds).toContain(defaultAgentId);
    expect(adminTeamIds).toContain(ownPrivate.agentId);
    expect(adminTeamIds).not.toContain(peerPrivate.agentId);
    const peerTeamIds = (await api.listTeam(peerAdmin)).map((entry) => {
      return entry.id;
    });
    expect(peerTeamIds).toContain(defaultAgentId);
    expect(peerTeamIds).toContain(peerPrivate.agentId);
    expect(peerTeamIds).not.toContain(ownPrivate.agentId);
    await expect(api.listTeam(crossOrgAdmin)).resolves.toStrictEqual([]);

    // Deleting the default agent clears the selection (FK set-null) and a
    // new default can then be configured.
    await api.deleteAgent(admin, defaultAgentId);
    const orphaned = await api.readOnboardingStatus(admin);
    expect(orphaned.defaultAgentId).toBeNull();
    const replacement = await api.createAgent(admin, {
      displayName: "BDD Replacement Default",
      visibility: "public",
    });
    const selected = await api.setDefaultAgent(admin, replacement.agentId);
    expect(selected).toStrictEqual({ agentId: replacement.agentId });
    const restored = await api.readOnboardingStatus(admin);
    expect(restored.defaultAgentId).toBe(replacement.agentId);

    const missingAgent = await api.requestSetDefaultAgent(
      crossOrgAdmin,
      randomUUID(),
      [404],
    );
    expectApiError(missingAgent.body);
    expect(missingAgent.body.error.message).toBe("Agent not found in this org");
  });
});

describe("ORG-03: onboarding setup edges", () => {
  it("gates non-admins, validates connectors, and survives clerk slug conflicts [ONBOARD-F]", async () => {
    const runs = createRunsAutomationsApi(context);
    api.acceptAgentStorageWrites();

    const unauthenticated = await api.requestSetupOnboarding(
      null,
      { displayName: "Anon Setup" },
      [401],
    );
    expect(unauthenticated.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    const gatekeptAdmin = api.user();
    const member = api.user({
      orgId: gatekeptAdmin.orgId,
      orgRole: "org:member",
    });
    const memberSetup = await api.requestSetupOnboarding(
      member,
      { displayName: "Member Setup" },
      [403],
    );
    expect(memberSetup.body).toStrictEqual({
      error: {
        message: "Only org admins can run onboarding setup",
        code: "FORBIDDEN",
      },
    });

    // Selected connectors are authorized to the default agent and visible
    // through the user-connectors read.
    const connectorAdmin = api.user();
    const connectorSetup = await api.requestSetupOnboarding(
      connectorAdmin,
      {
        displayName: "BDD Connector Setup",
        selectedConnectors: ["slack", "github"],
      },
      [200],
    );
    const connectorAgentId = connectorSetup.body.agentId;
    const enabled = await api.readEnabledConnectorTypes(
      connectorAdmin,
      connectorAgentId,
    );
    expect([...enabled].sort()).toStrictEqual(["github", "slack"]);

    // Unavailable connectors are rejected before any agent is created.
    const gatedAdmin = api.user();
    const gated = await api.requestSetupOnboarding(
      gatedAdmin,
      { displayName: "BDD Gated Setup", selectedConnectors: ["bentoml"] },
      [403],
    );
    expectApiError(gated.body);
    expect(gated.body.error.message).toBe(
      "Connector types are not available: bentoml",
    );
    await expect(api.listAgents(gatedAdmin)).resolves.toStrictEqual([]);

    // Repeated setup is idempotent on the agent but re-authorizes connectors.
    const repeated = await api.requestSetupOnboarding(
      connectorAdmin,
      { displayName: "BDD Connector Setup", selectedConnectors: ["github"] },
      [200],
    );
    expect(repeated.body.agentId).toBe(connectorAgentId);
    await expect(
      api.readEnabledConnectorTypes(connectorAdmin, connectorAgentId),
    ).resolves.toStrictEqual(["github"]);

    // A paid org never re-enters payment-pending onboarding on repeat setup.
    const paidAdmin = api.user();
    await runs.grantProEntitlement(paidAdmin);
    const paidRepeat = await api.requestSetupOnboarding(
      paidAdmin,
      { displayName: "BDD Paid Repeat", selectedConnectors: ["slack"] },
      [200],
    );
    expect(paidRepeat.body.agentId).toBeTruthy();
    const paidStatus = await api.readOnboardingStatus(paidAdmin);
    expect(paidStatus.needsOnboarding).toBeFalsy();

    // Clerk slug conflict retries with a suffixed slug.
    const conflictAdmin = api.user();
    const updateOrganization =
      context.mocks.clerk.organizations.updateOrganization;
    updateOrganization.mockClear();
    updateOrganization.mockImplementation((_orgId: unknown, data: unknown) => {
      if (recordOf(data).slug === "my-workspace") {
        return Promise.reject(slugConflictError());
      }
      return Promise.resolve({});
    });
    const retried = await api.requestSetupOnboarding(
      conflictAdmin,
      { displayName: "Zero", workspaceName: "My Workspace" },
      [200],
    );
    expect(retried.body.agentId).toBeTruthy();
    expect(updateOrganization.mock.calls).toHaveLength(2);
    const retryArgs = recordOf(updateOrganization.mock.calls[1]?.[1]);
    expect(retryArgs.name).toBe("My Workspace");
    expect(retryArgs.slug).toMatch(/^my-workspace-[a-z0-9]{6}$/);

    // When every slug candidate conflicts, the update falls back to name-only.
    const fallbackAdmin = api.user();
    updateOrganization.mockClear();
    updateOrganization.mockImplementation((_orgId: unknown, data: unknown) => {
      if ("slug" in recordOf(data)) {
        return Promise.reject(slugConflictError());
      }
      return Promise.resolve({});
    });
    const fallback = await api.requestSetupOnboarding(
      fallbackAdmin,
      { displayName: "Zero", workspaceName: "My Workspace" },
      [200],
    );
    expect(fallback.body.agentId).toBeTruthy();
    expect(updateOrganization.mock.calls).toHaveLength(3);
    expect(updateOrganization.mock.calls[2]).toStrictEqual([
      orgIdOf(fallbackAdmin),
      { name: "My Workspace" },
    ]);

    // Non-slug Clerk failures never block setup.
    const invalidNameAdmin = api.user();
    updateOrganization.mockClear();
    updateOrganization.mockRejectedValue(nonSlugClerkError());
    const tolerated = await api.requestSetupOnboarding(
      invalidNameAdmin,
      { displayName: "Zero", workspaceName: "Test Workspace" },
      [200],
    );
    const toleratedAgents = await api.listAgents(invalidNameAdmin);
    expect(
      toleratedAgents.some((agent) => {
        return agent.agentId === tolerated.body.agentId;
      }),
    ).toBeTruthy();

    // Non-Latin workspace names update the Clerk org name only.
    const cjkAdmin = api.user();
    updateOrganization.mockClear();
    updateOrganization.mockResolvedValue({});
    const cjk = await api.requestSetupOnboarding(
      cjkAdmin,
      { displayName: "Zero", workspaceName: "我的工作区" },
      [200],
    );
    expect(cjk.body.agentId).toBeTruthy();
    expect(updateOrganization).toHaveBeenCalledWith(orgIdOf(cjkAdmin), {
      name: "我的工作区",
    });
  });
});

describe("AUTH-02/ORG-01: run-scoped zero tokens on org routes", () => {
  it("serves org and member reads to a claimed run's zero token and rejects org writes [ORG-TOKEN-G]", async () => {
    const runs = createRunsAutomationsApi(context);
    const admin = api.user();
    api.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(admin);
    await runs.ensureOrgModelProvider(admin);
    const agent = await api.createAgent(admin, {
      displayName: "BDD Org Token Agent",
      visibility: "private",
    });

    const created = await runs.createRun(admin, {
      agentId: agent.agentId,
      prompt: "exercise org reads with the run zero token",
      modelProvider: "anthropic-api-key",
    });
    await runs.heartbeatRunner(runnerGroup);
    const poll = await runs.pollRunner(runnerGroup);
    expect(poll.body.job?.runId).toBe(created.runId);
    const claim = await runs.claimRunnerJob(created.runId);
    const zeroToken = claim.environment?.ZERO_TOKEN;
    if (!zeroToken) {
      throw new Error(
        "Expected claim.environment.ZERO_TOKEN to carry the run-scoped zero token",
      );
    }
    expect(zeroToken).toMatch(/^vm0_sandbox_/);

    const orgSlug = slug("bdd-r5-token");
    api.mockClerkOrg(admin, { slug: orgSlug, name: "BDD Token Org" });
    const orgRead = await api.requestReadOrgWithBearer(zeroToken, [200]);
    expect(orgRead.body).toMatchObject({
      id: admin.orgId,
      slug: orgSlug,
      role: "admin",
    });

    const membersRead = await api.requestListMembersWithBearer(
      zeroToken,
      [200],
    );
    expect(membersRead.body.role).toBe("admin");
    expect(
      membersRead.body.members.some((candidate) => {
        return candidate.userId === admin.userId;
      }),
    ).toBeTruthy();

    // Representative sandbox-token write rejections (the remaining org
    // routes share the same authRoute statement).
    const updateRejected = await api.requestUpdateOrgWithBearer(
      zeroToken,
      { name: "Token Rename", force: false },
      [403],
    );
    expect(updateRejected.body).toStrictEqual({
      error: {
        message: "This endpoint is not available for sandbox tokens",
        code: "FORBIDDEN",
      },
    });
    const logoRejected = await api.requestUploadOrgLogo(
      { bearerToken: zeroToken },
      logoForm(pngLogoFile()),
      [403],
    );
    expect(logoRejected.body).toStrictEqual({
      error: {
        message: "This endpoint is not available for sandbox tokens",
        code: "FORBIDDEN",
      },
    });

    await runs.requestCancelRun(admin, created.runId, [200]);
    const cancelled = await runs.readRun(admin, created.runId);
    expect(cancelled.status).toBe("cancelled");
  });
});
