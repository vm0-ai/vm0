import { describe, it, expect, beforeEach } from "vitest";
import { POST as createOrgRoute } from "../../org/route";
import { POST as inviteRoute } from "../../org/invite/route";
import { GET } from "../../scope/list/route";
import { createTestRequest } from "../../../../src/__tests__/api-test-helpers";
import { testContext, uniqueId } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { setupClerkOrgMock } from "../../../../src/__tests__/org-test-helpers";

const context = testContext();

describe("GET /api/scope/list - Scope List", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest("http://localhost:3000/api/scope/list");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should return personal scope", async () => {
    const user = await context.setupUser();
    setupClerkOrgMock({ userId: user.userId });

    const request = createTestRequest("http://localhost:3000/api/scope/list");
    const response = await GET(request);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.scopes.length).toBeGreaterThanOrEqual(1);

    const personal = data.scopes.find(
      (s: { slug: string; role: string }) => s.role === "admin",
    );
    expect(personal).toBeDefined();
  });

  it("should return org scopes with memberships", async () => {
    // Create an org (admin gets one scope from org creation)
    const adminUserId = uniqueId("list-admin");
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

    // Invite a member — the Clerk mock maps "list-member@example.com" -> "user_list-member"
    const memberUserId = "user_list-member";
    const memberEmail = "list-member@example.com";
    setupClerkOrgMock({
      userId: adminUserId,
      orgId,
      memberships: [
        { userId: adminUserId, role: "org:admin" },
        { userId: memberUserId, role: "org:member" },
      ],
    });

    const inviteReq = createTestRequest(
      `http://localhost:3000/api/org/invite?scope=${slug}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: memberEmail }),
      },
    );
    const inviteRes = await inviteRoute(inviteReq);
    expect(inviteRes.status).toBe(200);

    // List scopes as the member — should see the org scope
    mockClerk({ userId: memberUserId });
    const listReq = createTestRequest("http://localhost:3000/api/scope/list");
    const listRes = await GET(listReq);
    expect(listRes.status).toBe(200);

    const data = await listRes.json();
    expect(data.scopes.length).toBeGreaterThanOrEqual(1);

    const orgScope = data.scopes.find(
      (s: { slug: string; role: string }) => s.slug === slug,
    );
    expect(orgScope).toBeDefined();
    expect(orgScope.slug).toBe(slug);
    expect(orgScope.role).toBe("member");
  });

  it("should only return scopes where user has scope_members record", async () => {
    // User A creates a scope
    const userA = await context.setupUser({ prefix: "user-a" });

    // User B creates a separate scope
    await context.setupUser({ prefix: "user-b" });

    // List scopes for User B — should NOT include User A's scope
    const listReq = createTestRequest("http://localhost:3000/api/scope/list");
    const listRes = await GET(listReq);
    expect(listRes.status).toBe(200);

    const data = await listRes.json();

    // User B should only see their own scope, not User A's
    const slugs = data.scopes.map((s: { slug: string }) => s.slug);
    expect(slugs).not.toContain(
      expect.stringContaining(userA.userId.replace("user-a-", "scope-")),
    );
    expect(data.scopes.length).toBe(1);
    expect(data.scopes[0].role).toBe("admin");
  });
});
