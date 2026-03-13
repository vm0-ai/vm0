import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../list/route";
import { createTestRequest } from "../../../../src/__tests__/api-test-helpers";
import { testContext, uniqueId } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("GET /api/org/list - Org List", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest("http://localhost:3000/api/org/list");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should return personal org from Clerk memberships", async () => {
    const userId = uniqueId("list-user");
    const orgSlug = uniqueId("org");

    mockClerk({
      userId,
      clerkOrgs: [{ id: `org_${userId}`, slug: orgSlug, name: orgSlug }],
    });

    const request = createTestRequest("http://localhost:3000/api/org/list");
    const response = await GET(request);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.orgs).toHaveLength(1);
    expect(data.orgs[0].slug).toBe(orgSlug);
    expect(data.orgs[0].role).toBe("admin");
  });

  it("should return org list with correct roles", async () => {
    const memberUserId = uniqueId("list-member");
    const orgSlug = uniqueId("org");
    const orgId = uniqueId("org");

    // Mock Clerk to return the member's org membership with "member" role
    mockClerk({
      userId: memberUserId,
      clerkOrgs: [
        { id: orgId, slug: orgSlug, name: orgSlug, role: "org:member" },
      ],
    });

    const listReq = createTestRequest("http://localhost:3000/api/org/list");
    const listRes = await GET(listReq);
    expect(listRes.status).toBe(200);

    const data = await listRes.json();
    expect(data.orgs).toHaveLength(1);
    expect(data.orgs[0].slug).toBe(orgSlug);
    expect(data.orgs[0].role).toBe("member");
  });

  it("should only return orgs the user is a Clerk member of", async () => {
    const userBId = uniqueId("user-b");
    const userBOrgSlug = uniqueId("org-b");

    // User B only has their own org
    mockClerk({
      userId: userBId,
      clerkOrgs: [
        { id: `org_${userBId}`, slug: userBOrgSlug, name: userBOrgSlug },
      ],
    });

    const listReq = createTestRequest("http://localhost:3000/api/org/list");
    const listRes = await GET(listReq);
    expect(listRes.status).toBe(200);

    const data = await listRes.json();
    expect(data.orgs).toHaveLength(1);
    expect(data.orgs[0].slug).toBe(userBOrgSlug);
    expect(data.orgs[0].role).toBe("admin");
  });
});
