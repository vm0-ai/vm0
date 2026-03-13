import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../invite/route";
import { GET as getMembersRoute } from "../members/route";
import {
  createTestRequest,
  createTestOrg as createTestOrgHelper,
} from "../../../../src/__tests__/api-test-helpers";
import { testContext, uniqueId } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { setupClerkOrgMock } from "../../../../src/__tests__/clerk-org-mock";

const context = testContext();

/**
 * Helper to create an org and return its slug.
 */
async function createTestOrg(userId: string) {
  const slug = uniqueId("org");
  const orgId = `org_mock_${userId}`;
  setupClerkOrgMock({
    userId,
    orgId,
    orgSlug: slug,
    memberships: [{ userId, role: "org:admin" }],
  });

  await createTestOrgHelper(slug);

  return { slug, orgId };
}

describe("POST /api/org/invite - Invite Member", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/org/invite?org=test",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "member@example.com" }),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should require org query parameter", async () => {
    const userId = uniqueId("invite-user");
    mockClerk({ userId });

    const request = createTestRequest("http://localhost:3000/api/org/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "member@example.com" }),
    });
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should invite member and return success message", async () => {
    const userId = uniqueId("invite-admin");
    const { slug } = await createTestOrg(userId);

    const inviteReq = createTestRequest(
      `http://localhost:3000/api/org/invite?org=${slug}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "new-member@example.com" }),
      },
    );
    const inviteRes = await POST(inviteReq);
    expect(inviteRes.status).toBe(200);

    const inviteData = await inviteRes.json();
    expect(inviteData.message).toContain("new-member@example.com");
  });

  it("should make invited member visible in org members list", async () => {
    const adminUserId = uniqueId("invite-admin2");
    const memberUserId = "user_new-member";
    const memberEmail = "new-member@example.com";
    const { slug, orgId } = await createTestOrg(adminUserId);

    // Invite the member
    const inviteReq = createTestRequest(
      `http://localhost:3000/api/org/invite?org=${slug}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: memberEmail }),
      },
    );
    const inviteRes = await POST(inviteReq);
    expect(inviteRes.status).toBe(200);

    // After invite, Clerk org now includes the new member
    setupClerkOrgMock({
      userId: adminUserId,
      orgId,
      orgSlug: slug,
      memberships: [
        { userId: adminUserId, role: "org:admin" },
        { userId: memberUserId, role: "org:member" },
      ],
    });

    // Verify invited member appears in the members list
    const membersReq = createTestRequest(
      `http://localhost:3000/api/org/members?org=${slug}`,
    );
    const membersRes = await getMembersRoute(membersReq);
    expect(membersRes.status).toBe(200);

    const membersData = await membersRes.json();
    const invitedMember = membersData.members.find(
      (m: { userId: string }) => m.userId === memberUserId,
    );
    expect(invitedMember).toBeDefined();
    expect(invitedMember.role).toBe("member");
  });
});
