import { describe, it, expect, beforeEach, vi } from "vitest";
import { clerkClient } from "@clerk/nextjs/server";
import { POST as createOrgRoute } from "../../../../app/api/org/route";
import { GET as getOrgStatusRoute } from "../../../../app/api/org/status/route";
import { POST as inviteRoute } from "../../../../app/api/org/invite/route";
import { DELETE as removeMemberRoute } from "../../../../app/api/org/members/route";
import { POST as leaveOrgRoute } from "../../../../app/api/org/leave/route";
import { GET as listScopesRoute } from "../../../../app/api/scope/list/route";
import { POST as useScopeRoute } from "../../../../app/api/scope/use/route";
import { createTestRequest } from "../../../__tests__/api-test-helpers";
import { testContext, uniqueId } from "../../../__tests__/test-helpers";
import { mockClerk } from "../../../__tests__/clerk-mock";
import { resolveOrgAccessToken } from "../org-token-service";

const context = testContext();

const mockClerkClient = vi.mocked(clerkClient);

/**
 * Set up an extended Clerk mock that supports organization operations.
 */
function setupClerkOrgMock(options: {
  userId: string;
  orgId?: string;
  memberships?: Array<{
    userId: string;
    role: string;
    createdAt?: number;
  }>;
}) {
  const orgId = options.orgId ?? `org_${options.userId}`;
  const memberships = options.memberships ?? [
    { userId: options.userId, role: "org:admin", createdAt: Date.now() },
  ];

  mockClerk({ userId: options.userId });

  const mockOrganizations = {
    createOrganization: vi.fn().mockResolvedValue({
      id: orgId,
      name: "test-org",
      slug: "test-org",
    }),
    getOrganizationMembershipList: vi.fn().mockResolvedValue({
      data: memberships.map((m) => ({
        publicUserData: { userId: m.userId },
        role: m.role,
        createdAt: m.createdAt ?? Date.now(),
      })),
    }),
    createOrganizationInvitation: vi.fn().mockResolvedValue({
      id: "inv_test",
    }),
    deleteOrganizationMembership: vi.fn().mockResolvedValue({}),
  };

  const mockUsers = {
    getUser: vi.fn().mockImplementation((userId: string) =>
      Promise.resolve({
        id: userId,
        emailAddresses: [
          { id: "email_1", emailAddress: `${userId}@example.com` },
        ],
        primaryEmailAddressId: "email_1",
      }),
    ),
    getUserList: vi
      .fn()
      .mockImplementation((params: { emailAddress: string[] }) =>
        Promise.resolve({
          data: params.emailAddress.map((email) => ({
            id: `user_${email.split("@")[0]}`,
            emailAddresses: [{ id: "email_1", emailAddress: email }],
            primaryEmailAddressId: "email_1",
          })),
        }),
      ),
    getOrganizationMembershipList: vi.fn().mockResolvedValue({
      data: memberships.map((m) => ({
        organization: { id: orgId },
        role: m.role,
        publicUserData: { userId: m.userId },
      })),
    }),
  };

  mockClerkClient.mockResolvedValue({
    organizations: mockOrganizations,
    users: mockUsers,
  } as unknown as Awaited<ReturnType<typeof clerkClient>>);

  return { mockOrganizations, mockUsers };
}

describe("Organization Lifecycle", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should create an organization and return admin token", async () => {
    const user = await context.setupUser();
    const slug = uniqueId("org");
    const clerkMock = setupClerkOrgMock({ userId: user.userId });

    const request = createTestRequest("http://localhost:3000/api/org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });

    const response = await createOrgRoute(request);
    expect(response.status).toBe(201);

    const data = await response.json();
    expect(data.slug).toBe(slug);
    expect(data.role).toBe("admin");
    expect(clerkMock.mockOrganizations.createOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ slug, createdBy: user.userId }),
    );
  });

  it("should reject creating a second organization", async () => {
    const user = await context.setupUser();
    const slug1 = uniqueId("org");
    const slug2 = uniqueId("org");
    setupClerkOrgMock({ userId: user.userId });

    const request1 = createTestRequest("http://localhost:3000/api/org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: slug1 }),
    });
    const response1 = await createOrgRoute(request1);
    expect(response1.status).toBe(201);

    const request2 = createTestRequest("http://localhost:3000/api/org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: slug2 }),
    });
    const response2 = await createOrgRoute(request2);
    expect(response2.status).toBe(400);

    const data = await response2.json();
    expect(data.error.message).toContain("already have an organization");
  });

  it("should list scopes including org membership", async () => {
    const user = await context.setupUser();
    const slug = uniqueId("org");
    const orgId = `org_${user.userId}`;
    setupClerkOrgMock({
      userId: user.userId,
      orgId,
      memberships: [{ userId: user.userId, role: "org:admin" }],
    });

    const createReq = createTestRequest("http://localhost:3000/api/org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    await createOrgRoute(createReq);

    const listReq = createTestRequest("http://localhost:3000/api/scope/list");
    const listRes = await listScopesRoute(listReq);
    expect(listRes.status).toBe(200);

    const data = await listRes.json();
    expect(data.scopes.length).toBeGreaterThanOrEqual(1);

    const personal = data.scopes.find(
      (s: { type: string }) => s.type === "personal",
    );
    expect(personal).toBeDefined();
  });

  it("should switch to org scope and get org access token", async () => {
    const user = await context.setupUser();
    const slug = uniqueId("org");
    const orgId = `org_${user.userId}`;
    setupClerkOrgMock({
      userId: user.userId,
      orgId,
      memberships: [{ userId: user.userId, role: "org:admin" }],
    });

    const createReq = createTestRequest("http://localhost:3000/api/org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const createRes = await createOrgRoute(createReq);
    expect(createRes.status).toBe(201);

    const useReq = createTestRequest("http://localhost:3000/api/scope/use", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const useRes = await useScopeRoute(useReq);
    expect(useRes.status).toBe(200);

    const data = await useRes.json();
    expect(data.scope.slug).toBe(slug);
    expect(data.token).toBeTruthy();
    expect(data.token).toMatch(/^vm0_org_/);
    expect(data.expiresAt).toBeTruthy();
  });

  it("should get org status with org access token", async () => {
    const user = await context.setupUser();
    const slug = uniqueId("org");
    const orgId = `org_${user.userId}`;
    setupClerkOrgMock({
      userId: user.userId,
      orgId,
      memberships: [{ userId: user.userId, role: "org:admin" }],
    });

    const createReq = createTestRequest("http://localhost:3000/api/org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const createRes = await createOrgRoute(createReq);
    expect(createRes.status).toBe(201);

    const useReq = createTestRequest("http://localhost:3000/api/scope/use", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const useRes = await useScopeRoute(useReq);
    const useData = await useRes.json();

    const statusReq = createTestRequest(
      "http://localhost:3000/api/org/status",
      { headers: { Authorization: `Bearer ${useData.token}` } },
    );
    const statusRes = await getOrgStatusRoute(statusReq);
    expect(statusRes.status).toBe(200);

    const statusData = await statusRes.json();
    expect(statusData.slug).toBe(slug);
    expect(statusData.role).toBe("admin");
    expect(statusData.members).toHaveLength(1);
    expect(statusData.members[0].role).toBe("admin");
  });

  it("should invite a member (admin only)", async () => {
    const user = await context.setupUser();
    const slug = uniqueId("org");
    const orgId = `org_${user.userId}`;
    const clerkMock = setupClerkOrgMock({
      userId: user.userId,
      orgId,
      memberships: [{ userId: user.userId, role: "org:admin" }],
    });

    const createReq = createTestRequest("http://localhost:3000/api/org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    await createOrgRoute(createReq);

    const useReq = createTestRequest("http://localhost:3000/api/scope/use", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const useRes = await useScopeRoute(useReq);
    const useData = await useRes.json();

    const inviteReq = createTestRequest(
      "http://localhost:3000/api/org/invite",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${useData.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: "new-member@example.com" }),
      },
    );
    const inviteRes = await inviteRoute(inviteReq);
    expect(inviteRes.status).toBe(200);

    const inviteData = await inviteRes.json();
    expect(inviteData.message).toContain("new-member@example.com");

    expect(
      clerkMock.mockOrganizations.createOrganizationInvitation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAddress: "new-member@example.com",
        role: "org:member",
      }),
    );
  });

  it("should remove a member and revoke their tokens", async () => {
    const user = await context.setupUser();
    const slug = uniqueId("org");
    const memberUserId = uniqueId("member");
    const orgId = `org_${user.userId}`;

    setupClerkOrgMock({
      userId: user.userId,
      orgId,
      memberships: [
        { userId: user.userId, role: "org:admin" },
        { userId: memberUserId, role: "org:member" },
      ],
    });

    const createReq = createTestRequest("http://localhost:3000/api/org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const createRes = await createOrgRoute(createReq);
    expect(createRes.status).toBe(201);

    const useReq = createTestRequest("http://localhost:3000/api/scope/use", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const useRes = await useScopeRoute(useReq);
    const useData = await useRes.json();

    // Use an email that maps to the memberUserId via the getUserList mock
    // getUserList returns id: `user_${email.split("@")[0]}`
    // So we need: user_<prefix> === memberUserId
    // Since memberUserId = "member-XXXX", we need email = "member-XXXX@example.com"
    // But getUserList returns "user_member-XXXX", not "member-XXXX"
    // Fix: override getUserList to return the exact memberUserId
    const client = await clerkClient();
    vi.mocked(client.users.getUserList).mockResolvedValue({
      data: [
        {
          id: memberUserId,
          emailAddresses: [
            { id: "email_1", emailAddress: "member@example.com" },
          ],
          primaryEmailAddressId: "email_1",
        },
      ],
    } as unknown as Awaited<ReturnType<typeof client.users.getUserList>>);

    const removeReq = createTestRequest(
      "http://localhost:3000/api/org/members",
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${useData.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: "member@example.com" }),
      },
    );
    const removeRes = await removeMemberRoute(removeReq);
    expect(removeRes.status).toBe(200);

    const removeData = await removeRes.json();
    expect(removeData.message).toContain("member@example.com");
  });

  it("should prevent admin from leaving", async () => {
    const user = await context.setupUser();
    const slug = uniqueId("org");
    const orgId = `org_${user.userId}`;
    setupClerkOrgMock({
      userId: user.userId,
      orgId,
      memberships: [{ userId: user.userId, role: "org:admin" }],
    });

    const createReq = createTestRequest("http://localhost:3000/api/org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    await createOrgRoute(createReq);

    const useReq = createTestRequest("http://localhost:3000/api/scope/use", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const useRes = await useScopeRoute(useReq);
    const useData = await useRes.json();

    const leaveReq = createTestRequest("http://localhost:3000/api/org/leave", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${useData.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const leaveRes = await leaveOrgRoute(leaveReq);
    expect(leaveRes.status).toBe(403);

    const leaveData = await leaveRes.json();
    expect(leaveData.error.message).toContain("Admin");
  });

  it("should reject unauthenticated requests", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest("http://localhost:3000/api/org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: uniqueId("org") }),
    });
    const response = await createOrgRoute(request);
    expect(response.status).toBe(401);
  });

  it("should reject org status without org token", async () => {
    await context.setupUser();

    const statusReq = createTestRequest("http://localhost:3000/api/org/status");
    const statusRes = await getOrgStatusRoute(statusReq);
    expect(statusRes.status).toBe(403);
  });

  it("should switch back to personal scope", async () => {
    const user = await context.setupUser();
    setupClerkOrgMock({ userId: user.userId });

    const listReq = createTestRequest("http://localhost:3000/api/scope/list");
    const listRes = await listScopesRoute(listReq);
    const listData = await listRes.json();

    const personal = listData.scopes.find(
      (s: { type: string }) => s.type === "personal",
    );
    expect(personal).toBeDefined();

    const useReq = createTestRequest("http://localhost:3000/api/scope/use", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: personal.slug }),
    });
    const useRes = await useScopeRoute(useReq);
    expect(useRes.status).toBe(200);

    const data = await useRes.json();
    expect(data.scope.type).toBe("personal");
    expect(data.token).toBe("");
    expect(data.expiresAt).toBe("");
  });

  it("should revoke org token after member removal", async () => {
    const user = await context.setupUser();
    const slug = uniqueId("org");
    const memberUserId = uniqueId("member");
    const orgId = `org_${user.userId}`;

    setupClerkOrgMock({
      userId: user.userId,
      orgId,
      memberships: [
        { userId: user.userId, role: "org:admin" },
        { userId: memberUserId, role: "org:member" },
      ],
    });

    const createReq = createTestRequest("http://localhost:3000/api/org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const createRes = await createOrgRoute(createReq);
    expect(createRes.status).toBe(201);

    // Generate token for member by simulating scope use
    mockClerk({ userId: memberUserId });
    setupClerkOrgMock({
      userId: memberUserId,
      orgId,
      memberships: [
        { userId: user.userId, role: "org:admin" },
        { userId: memberUserId, role: "org:member" },
      ],
    });

    const memberUseReq = createTestRequest(
      "http://localhost:3000/api/scope/use",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      },
    );
    const memberUseRes = await useScopeRoute(memberUseReq);
    expect(memberUseRes.status).toBe(200);
    const memberUseData = await memberUseRes.json();
    const memberOrgToken = memberUseData.token;

    // Verify the member token is valid
    const resolved = await resolveOrgAccessToken(memberOrgToken);
    expect(resolved).not.toBeNull();
    expect(resolved?.userId).toBe(memberUserId);

    // Switch back to admin and remove the member
    setupClerkOrgMock({
      userId: user.userId,
      orgId,
      memberships: [
        { userId: user.userId, role: "org:admin" },
        { userId: memberUserId, role: "org:member" },
      ],
    });

    const adminUseReq = createTestRequest(
      "http://localhost:3000/api/scope/use",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      },
    );
    const adminUseRes = await useScopeRoute(adminUseReq);
    const adminUseData = await adminUseRes.json();

    // Override getUserList to return memberUserId for the email
    const adminClient = await clerkClient();
    vi.mocked(adminClient.users.getUserList).mockResolvedValue({
      data: [
        {
          id: memberUserId,
          emailAddresses: [
            { id: "email_1", emailAddress: "member-revoke@example.com" },
          ],
          primaryEmailAddressId: "email_1",
        },
      ],
    } as unknown as Awaited<ReturnType<typeof adminClient.users.getUserList>>);

    const removeReq = createTestRequest(
      "http://localhost:3000/api/org/members",
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${adminUseData.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: "member-revoke@example.com" }),
      },
    );
    const removeRes = await removeMemberRoute(removeReq);
    expect(removeRes.status).toBe(200);

    // Verify the member's token is revoked
    const resolvedAfter = await resolveOrgAccessToken(memberOrgToken);
    expect(resolvedAfter).toBeNull();
  });
});
