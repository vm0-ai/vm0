import { describe, it, expect, beforeEach } from "vitest";
import { POST as createOrgRoute } from "../../org/route";
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
    const user = await context.setupUser();
    const slug = uniqueId("org");
    const orgId = `org_${user.userId}`;
    setupClerkOrgMock({
      userId: user.userId,
      orgId,
      memberships: [{ userId: user.userId, role: "org:admin" }],
    });

    // Create org first
    const createReq = createTestRequest("http://localhost:3000/api/org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    await createOrgRoute(createReq);

    // List scopes
    const listReq = createTestRequest("http://localhost:3000/api/scope/list");
    const listRes = await GET(listReq);
    expect(listRes.status).toBe(200);

    const data = await listRes.json();
    expect(data.scopes.length).toBeGreaterThanOrEqual(2);

    const personal = data.scopes.find(
      (s: { slug: string; role: string }) => s.role === "admin",
    );
    expect(personal).toBeDefined();

    const org = data.scopes.find(
      (s: { slug: string; role: string }) => s.slug === slug,
    );
    expect(org).toBeDefined();
    expect(org.slug).toBe(slug);
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
