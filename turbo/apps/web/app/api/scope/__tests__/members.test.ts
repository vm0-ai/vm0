import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST as createScopeRoute } from "../route";
import { POST as inviteRoute } from "../invite/route";
import { GET, DELETE } from "../members/route";
import { createTestRequest } from "../../../../src/__tests__/api-test-helpers";
import { testContext, uniqueId } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { setupClerkOrgMock } from "../../../../src/__tests__/org-test-helpers";
import { clerkClient } from "@clerk/nextjs/server";

const context = testContext();

/**
 * Helper to create a scope with a fresh user.
 */
async function createScope(userId: string) {
  const slug = uniqueId("scope");
  const orgId = `org_${userId}`;
  setupClerkOrgMock({
    userId,
    orgId,
    memberships: [{ userId, role: "org:admin" }],
  });

  const createReq = createTestRequest("http://localhost:3000/api/scope", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug }),
  });
  const createRes = await createScopeRoute(createReq);
  if (createRes.status !== 201) {
    const body = await createRes.json();
    throw new Error(`Failed to create scope: ${body.error?.message}`);
  }

  return { slug, orgId };
}

/**
 * Helper to invite a member via API and set up Clerk mock for both users.
 */
async function addMember(
  adminUserId: string,
  memberUserId: string,
  memberEmail: string,
  slug: string,
  orgId: string,
) {
  setupClerkOrgMock({
    userId: adminUserId,
    orgId,
    memberships: [
      { userId: adminUserId, role: "org:admin" },
      { userId: memberUserId, role: "org:member" },
    ],
  });

  const inviteReq = createTestRequest(
    `http://localhost:3000/api/scope/invite?scope=${slug}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: memberEmail }),
    },
  );
  const inviteRes = await inviteRoute(inviteReq);
  if (inviteRes.status !== 200) {
    const body = await inviteRes.json();
    throw new Error(`Failed to invite member: ${body.error?.message}`);
  }
}

describe("GET /api/scope/members - Scope Members", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/scope/members?scope=test",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should require scope query parameter", async () => {
    const userId = uniqueId("members-user");
    mockClerk({ userId });

    const request = createTestRequest(
      "http://localhost:3000/api/scope/members",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("scope query parameter is required");
  });

  it("should return scope status with members", async () => {
    const userId = uniqueId("status-admin");
    const slug = uniqueId("scope");
    const orgId = `org_${userId}`;
    setupClerkOrgMock({
      userId,
      orgId,
      memberships: [{ userId, role: "org:admin" }],
    });

    const createReq = createTestRequest("http://localhost:3000/api/scope", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const createRes = await createScopeRoute(createReq);
    expect(createRes.status).toBe(201);

    const statusReq = createTestRequest(
      `http://localhost:3000/api/scope/members?scope=${slug}`,
    );
    const statusRes = await GET(statusReq);
    expect(statusRes.status).toBe(200);

    const statusData = await statusRes.json();
    expect(statusData.slug).toBe(slug);
    expect(statusData.role).toBe("admin");
    expect(statusData.members).toHaveLength(1);
    expect(statusData.members[0].role).toBe("admin");
  });

  describe("Clerk lazy sync", () => {
    it("should auto-sync scope membership from Clerk org when user is not in scope_members", async () => {
      const adminUserId = uniqueId("admin");
      const memberUserId = uniqueId("member");
      const slug = uniqueId("scope");
      const orgId = `org_${adminUserId}`;

      setupClerkOrgMock({
        userId: adminUserId,
        orgId,
        memberships: [
          { userId: adminUserId, role: "org:admin" },
          { userId: memberUserId, role: "org:member" },
        ],
      });

      const createReq = createTestRequest("http://localhost:3000/api/scope", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const createRes = await createScopeRoute(createReq);
      expect(createRes.status).toBe(201);

      // Switch to member user who is in Clerk org but NOT in scope_members
      setupClerkOrgMock({
        userId: memberUserId,
        orgId,
        memberships: [
          { userId: adminUserId, role: "org:admin" },
          { userId: memberUserId, role: "org:member" },
        ],
      });

      // Member accesses scope members -- should trigger lazy sync
      const statusReq = createTestRequest(
        `http://localhost:3000/api/scope/members?scope=${slug}`,
      );
      const statusRes = await GET(statusReq);
      expect(statusRes.status).toBe(200);

      const statusData = await statusRes.json();
      expect(statusData.slug).toBe(slug);
      expect(statusData.role).toBe("member");
    });

    it("should return 403 when user is not in Clerk org and not in scope_members", async () => {
      const adminUserId = uniqueId("admin");
      const outsiderUserId = uniqueId("outsider");
      const slug = uniqueId("scope");
      const orgId = `org_${adminUserId}`;

      setupClerkOrgMock({
        userId: adminUserId,
        orgId,
        memberships: [{ userId: adminUserId, role: "org:admin" }],
      });

      const createReq = createTestRequest("http://localhost:3000/api/scope", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const createRes = await createScopeRoute(createReq);
      expect(createRes.status).toBe(201);

      // Switch to outsider who is NOT in Clerk org
      setupClerkOrgMock({
        userId: outsiderUserId,
        orgId,
        memberships: [{ userId: adminUserId, role: "org:admin" }],
      });

      const statusReq = createTestRequest(
        `http://localhost:3000/api/scope/members?scope=${slug}`,
      );
      const statusRes = await GET(statusReq);
      expect(statusRes.status).toBe(403);
    });

    it("should return 403 when Clerk API fails during lazy sync", async () => {
      const adminUserId = uniqueId("admin");
      const memberUserId = uniqueId("member");
      const slug = uniqueId("scope");
      const orgId = `org_${adminUserId}`;

      setupClerkOrgMock({
        userId: adminUserId,
        orgId,
        memberships: [{ userId: adminUserId, role: "org:admin" }],
      });

      const createReq = createTestRequest("http://localhost:3000/api/scope", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const createRes = await createScopeRoute(createReq);
      expect(createRes.status).toBe(201);

      // Switch to member user, but make Clerk API fail
      setupClerkOrgMock({
        userId: memberUserId,
        orgId,
        memberships: [],
      });
      const client = await clerkClient();
      vi.mocked(
        client.organizations.getOrganizationMembershipList,
      ).mockRejectedValue(new Error("Clerk API unavailable"));

      const statusReq = createTestRequest(
        `http://localhost:3000/api/scope/members?scope=${slug}`,
      );
      const statusRes = await GET(statusReq);
      expect(statusRes.status).toBe(403);
    });
  });
});

describe("DELETE /api/scope/members - Remove Member", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/scope/members?scope=test",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "member@example.com" }),
      },
    );
    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should require scope query parameter", async () => {
    const userId = uniqueId("members-user");
    mockClerk({ userId });

    const request = createTestRequest(
      "http://localhost:3000/api/scope/members",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "member@example.com" }),
      },
    );
    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("scope query parameter is required");
  });

  it("should remove member and return success message", async () => {
    const adminUserId = uniqueId("admin");
    const memberEmail = "member@example.com";
    const memberUserId = "user_member";
    const { slug, orgId } = await createScope(adminUserId);

    await addMember(adminUserId, memberUserId, memberEmail, slug, orgId);

    // Override getUserList for the removal to return the correct member ID
    const client = await clerkClient();
    vi.mocked(client.users.getUserList).mockResolvedValue({
      data: [
        {
          id: memberUserId,
          emailAddresses: [{ id: "email_1", emailAddress: memberEmail }],
          primaryEmailAddressId: "email_1",
        },
      ],
    } as unknown as Awaited<ReturnType<typeof client.users.getUserList>>);

    const removeReq = createTestRequest(
      `http://localhost:3000/api/scope/members?scope=${slug}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: memberEmail }),
      },
    );
    const removeRes = await DELETE(removeReq);
    expect(removeRes.status).toBe(200);

    const removeData = await removeRes.json();
    expect(removeData.message).toContain(memberEmail);
  });

  it("should revoke member access after removal", async () => {
    const adminUserId = uniqueId("admin");
    const memberEmail = "member-revoke@example.com";
    const memberUserId = "user_member-revoke";
    const { slug, orgId } = await createScope(adminUserId);

    await addMember(adminUserId, memberUserId, memberEmail, slug, orgId);

    // Verify member can access scope members
    setupClerkOrgMock({
      userId: memberUserId,
      orgId,
      memberships: [
        { userId: adminUserId, role: "org:admin" },
        { userId: memberUserId, role: "org:member" },
      ],
    });
    const statusReq1 = createTestRequest(
      `http://localhost:3000/api/scope/members?scope=${slug}`,
    );
    const statusRes1 = await GET(statusReq1);
    expect(statusRes1.status).toBe(200);

    // Switch back to admin and remove the member
    setupClerkOrgMock({
      userId: adminUserId,
      orgId,
      memberships: [
        { userId: adminUserId, role: "org:admin" },
        { userId: memberUserId, role: "org:member" },
      ],
    });

    const adminClient = await clerkClient();
    vi.mocked(adminClient.users.getUserList).mockResolvedValue({
      data: [
        {
          id: memberUserId,
          emailAddresses: [{ id: "email_1", emailAddress: memberEmail }],
          primaryEmailAddressId: "email_1",
        },
      ],
    } as unknown as Awaited<ReturnType<typeof adminClient.users.getUserList>>);

    const removeReq = createTestRequest(
      `http://localhost:3000/api/scope/members?scope=${slug}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: memberEmail }),
      },
    );
    const removeRes = await DELETE(removeReq);
    expect(removeRes.status).toBe(200);

    // Verify member can no longer access scope members
    mockClerk({ userId: memberUserId });
    const statusReq2 = createTestRequest(
      `http://localhost:3000/api/scope/members?scope=${slug}`,
    );
    const statusRes2 = await GET(statusReq2);
    expect(statusRes2.status).toBe(403);
  });
});
