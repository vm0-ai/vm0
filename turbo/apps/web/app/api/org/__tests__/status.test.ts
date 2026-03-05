import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST as createOrgRoute } from "../route";
import { GET } from "../status/route";
import { createTestRequest } from "../../../../src/__tests__/api-test-helpers";
import { testContext, uniqueId } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { setupClerkOrgMock } from "../../../../src/__tests__/org-test-helpers";
import { clerkClient } from "@clerk/nextjs/server";

const context = testContext();

describe("GET /api/org/status - Organization Status", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/org/status?scope=test",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should require scope query parameter", async () => {
    const userId = uniqueId("status-user");
    mockClerk({ userId });

    const request = createTestRequest("http://localhost:3000/api/org/status");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("scope query parameter is required");
  });

  it("should return org status with members", async () => {
    const userId = uniqueId("status-admin");
    const slug = uniqueId("org");
    const orgId = `org_${userId}`;
    setupClerkOrgMock({
      userId,
      orgId,
      memberships: [{ userId, role: "org:admin" }],
    });

    // Create org (fresh user, no existing scope)
    const createReq = createTestRequest("http://localhost:3000/api/org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const createRes = await createOrgRoute(createReq);
    expect(createRes.status).toBe(201);

    // Get org status with scope query param
    const statusReq = createTestRequest(
      `http://localhost:3000/api/org/status?scope=${slug}`,
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
      // 1. Admin creates an org/scope
      const adminUserId = uniqueId("admin");
      const memberUserId = uniqueId("member");
      const slug = uniqueId("org");
      const orgId = `org_${adminUserId}`;

      setupClerkOrgMock({
        userId: adminUserId,
        orgId,
        memberships: [
          { userId: adminUserId, role: "org:admin" },
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

      // 2. Switch to member user who is in Clerk org but NOT in scope_members
      //    The Clerk mock returns both users as org members
      setupClerkOrgMock({
        userId: memberUserId,
        orgId,
        memberships: [
          { userId: adminUserId, role: "org:admin" },
          { userId: memberUserId, role: "org:member" },
        ],
      });

      // 3. Member accesses org status — should trigger lazy sync
      const statusReq = createTestRequest(
        `http://localhost:3000/api/org/status?scope=${slug}`,
      );
      const statusRes = await GET(statusReq);
      expect(statusRes.status).toBe(200);

      const statusData = await statusRes.json();
      expect(statusData.slug).toBe(slug);
      // Lazy sync assigns "member" role for non-admin Clerk members
      expect(statusData.role).toBe("member");
    });

    it("should return 403 when user is not in Clerk org and not in scope_members", async () => {
      // 1. Admin creates an org/scope
      const adminUserId = uniqueId("admin");
      const outsiderUserId = uniqueId("outsider");
      const slug = uniqueId("org");
      const orgId = `org_${adminUserId}`;

      setupClerkOrgMock({
        userId: adminUserId,
        orgId,
        memberships: [{ userId: adminUserId, role: "org:admin" }],
      });

      const createReq = createTestRequest("http://localhost:3000/api/org", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const createRes = await createOrgRoute(createReq);
      expect(createRes.status).toBe(201);

      // 2. Switch to outsider who is NOT in Clerk org
      setupClerkOrgMock({
        userId: outsiderUserId,
        orgId,
        memberships: [{ userId: adminUserId, role: "org:admin" }],
      });

      // 3. Outsider tries to access org status — should fail
      const statusReq = createTestRequest(
        `http://localhost:3000/api/org/status?scope=${slug}`,
      );
      const statusRes = await GET(statusReq);
      expect(statusRes.status).toBe(403);
    });

    it("should return 403 when Clerk API fails during lazy sync", async () => {
      // 1. Admin creates an org/scope
      const adminUserId = uniqueId("admin");
      const memberUserId = uniqueId("member");
      const slug = uniqueId("org");
      const orgId = `org_${adminUserId}`;

      setupClerkOrgMock({
        userId: adminUserId,
        orgId,
        memberships: [{ userId: adminUserId, role: "org:admin" }],
      });

      const createReq = createTestRequest("http://localhost:3000/api/org", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const createRes = await createOrgRoute(createReq);
      expect(createRes.status).toBe(201);

      // 2. Switch to member user, but make Clerk API fail
      setupClerkOrgMock({
        userId: memberUserId,
        orgId,
        memberships: [],
      });
      const client = await clerkClient();
      vi.mocked(
        client.organizations.getOrganizationMembershipList,
      ).mockRejectedValue(new Error("Clerk API unavailable"));

      // 3. Member tries to access — Clerk sync fails gracefully, returns 403
      const statusReq = createTestRequest(
        `http://localhost:3000/api/org/status?scope=${slug}`,
      );
      const statusRes = await GET(statusReq);
      expect(statusRes.status).toBe(403);
    });
  });
});
