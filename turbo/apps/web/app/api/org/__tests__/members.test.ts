import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../members/route";
import {
  createTestRequest,
  createTestOrg as createTestOrgHelper,
} from "../../../../src/__tests__/api-test-helpers";
import { testContext, uniqueId } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { setupClerkOrgMock } from "../../../../src/__tests__/clerk-org-mock";
import { clerkClient } from "@clerk/nextjs/server";

const context = testContext();

/**
 * Helper to create an org via the test helper
 */
async function createTestOrg(userId: string) {
  const slug = uniqueId("org");
  setupClerkOrgMock({
    userId,
    orgId: `org_mock_${userId}`,
    orgSlug: slug,
    memberships: [{ userId, role: "org:admin" }],
  });

  await createTestOrgHelper(slug);
  return { slug, orgId: `org_mock_${userId}` };
}

describe("GET /api/org/members - Org Members", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/org/members?org=test",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should require org query parameter", async () => {
    const userId = uniqueId("members-user");
    mockClerk({ userId });

    const request = createTestRequest("http://localhost:3000/api/org/members");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should return org members", async () => {
    const userId = uniqueId("members-admin");
    const { slug, orgId } = await createTestOrg(userId);

    setupClerkOrgMock({
      userId,
      orgId,
      orgSlug: slug,
      memberships: [{ userId, role: "org:admin" }],
    });

    const statusReq = createTestRequest(
      `http://localhost:3000/api/org/members?org=${slug}`,
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
    it("should auto-sync org membership from Clerk when user is not yet known locally", async () => {
      const adminUserId = uniqueId("admin");
      const memberUserId = uniqueId("member");
      const { slug, orgId } = await createTestOrg(adminUserId);

      // Switch to member user who is in Clerk org but not yet synced locally
      setupClerkOrgMock({
        userId: memberUserId,
        orgId,
        orgSlug: slug,
        memberships: [
          { userId: adminUserId, role: "org:admin" },
          { userId: memberUserId, role: "org:member" },
        ],
      });

      const statusReq = createTestRequest(
        `http://localhost:3000/api/org/members?org=${slug}`,
      );
      const statusRes = await GET(statusReq);
      expect(statusRes.status).toBe(200);

      const statusData = await statusRes.json();
      expect(statusData.slug).toBe(slug);
      expect(statusData.role).toBe("member");
    });

    it("should return 403 when user is not in Clerk org", async () => {
      const adminUserId = uniqueId("admin");
      const outsiderUserId = uniqueId("outsider");
      const { slug, orgId } = await createTestOrg(adminUserId);

      setupClerkOrgMock({
        userId: outsiderUserId,
        orgId,
        orgSlug: slug,
        memberships: [{ userId: adminUserId, role: "org:admin" }],
      });

      const statusReq = createTestRequest(
        `http://localhost:3000/api/org/members?org=${slug}`,
      );
      const statusRes = await GET(statusReq);
      expect(statusRes.status).toBe(403);
    });

    it("should propagate Clerk API errors during lazy sync", async () => {
      const adminUserId = uniqueId("admin");
      const memberUserId = uniqueId("member");
      const { slug, orgId } = await createTestOrg(adminUserId);

      setupClerkOrgMock({
        userId: memberUserId,
        orgId,
        orgSlug: slug,
        memberships: [],
      });
      const client = await clerkClient();
      vi.mocked(client.users.getOrganizationMembershipList).mockRejectedValue(
        new Error("Clerk API unavailable"),
      );

      const statusReq = createTestRequest(
        `http://localhost:3000/api/org/members?org=${slug}`,
      );
      await expect(GET(statusReq)).rejects.toThrow("Clerk API unavailable");
    });
  });
});
