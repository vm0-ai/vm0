import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST as createScopeRoute } from "../route";
import { POST as inviteRoute } from "../invite/route";
import { DELETE } from "../members/route";
import { GET as getMembersRoute } from "../members/route";
import { createTestRequest } from "../../../../src/__tests__/api-test-helpers";
import { testContext, uniqueId } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { setupClerkOrgMock } from "../../../../src/__tests__/clerk-org-mock";
import { clerkClient } from "@clerk/nextjs/server";

const context = testContext();

/**
 * Helper to create a scope with a fresh user.
 */
async function createTestScope(userId: string) {
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
    expect(data.error.message).toContain(
      "scope or org query parameter is required",
    );
  });

  it("should remove member and return success message", async () => {
    const adminUserId = uniqueId("admin");
    const memberEmail = "member@example.com";
    // Clerk mock maps "member@example.com" -> "user_member"
    const memberUserId = "user_member";
    const { slug, orgId } = await createTestScope(adminUserId);

    // Add member via invite API
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
    // Clerk mock maps "member-revoke@example.com" -> "user_member-revoke"
    const memberUserId = "user_member-revoke";
    const { slug, orgId } = await createTestScope(adminUserId);

    // Add member via invite API
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
    const statusRes1 = await getMembersRoute(statusReq1);
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

    // Override getUserList to return memberUserId for the email
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

    // Verify member is no longer in the Clerk org membership list.
    // Use admin user to check — the removed member can no longer access the scope.
    setupClerkOrgMock({
      userId: adminUserId,
      orgId,
      memberships: [{ userId: adminUserId, role: "org:admin" }],
    });
    const statusReq2 = createTestRequest(
      `http://localhost:3000/api/scope/members?scope=${slug}`,
    );
    const statusRes2 = await getMembersRoute(statusReq2);
    expect(statusRes2.status).toBe(200);
    const statusData2 = await statusRes2.json();
    const removedMember = statusData2.members.find(
      (m: { userId: string }) => m.userId === memberUserId,
    );
    expect(removedMember).toBeUndefined();
  });
});
