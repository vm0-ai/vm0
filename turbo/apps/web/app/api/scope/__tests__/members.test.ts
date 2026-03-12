import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../members/route";
import {
  createTestRequest,
  createTestScope as createTestScopeHelper,
} from "../../../../src/__tests__/api-test-helpers";
import { testContext, uniqueId } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { setupClerkOrgMock } from "../../../../src/__tests__/clerk-org-mock";
import { clerkClient } from "@clerk/nextjs/server";

const context = testContext();

/**
 * Helper to create a scope via the test helper
 */
async function createTestScope(userId: string) {
  const slug = uniqueId("scope");
  setupClerkOrgMock({
    userId,
    orgId: `org_mock_${userId}`,
    orgSlug: slug,
    memberships: [{ userId, role: "org:admin" }],
  });

  await createTestScopeHelper(slug);
  return { slug, orgId: `org_mock_${userId}` };
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
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should return scope members", async () => {
    const userId = uniqueId("members-admin");
    const { slug, orgId } = await createTestScope(userId);

    setupClerkOrgMock({
      userId,
      orgId,
      orgSlug: slug,
      memberships: [{ userId, role: "org:admin" }],
    });

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
    it("should auto-sync org membership from Clerk when user is not yet known locally", async () => {
      const adminUserId = uniqueId("admin");
      const memberUserId = uniqueId("member");
      const { slug, orgId } = await createTestScope(adminUserId);

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
        `http://localhost:3000/api/scope/members?scope=${slug}`,
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
      const { slug, orgId } = await createTestScope(adminUserId);

      setupClerkOrgMock({
        userId: outsiderUserId,
        orgId,
        orgSlug: slug,
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
      const { slug, orgId } = await createTestScope(adminUserId);

      setupClerkOrgMock({
        userId: memberUserId,
        orgId,
        orgSlug: slug,
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
