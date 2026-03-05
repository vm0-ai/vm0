import { describe, it, expect, beforeEach } from "vitest";
import { POST as createOrgRoute } from "../route";
import { POST } from "../invite/route";
import { GET as listScopesRoute } from "../../scope/list/route";
import { createTestRequest } from "../../../../src/__tests__/api-test-helpers";
import { testContext, uniqueId } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { setupClerkOrgMock } from "../../../../src/__tests__/org-test-helpers";

const context = testContext();

/**
 * Helper to create an org and return its slug.
 * Uses a fresh user (no existing scope) to avoid the one-org-per-user limit.
 */
async function createOrg(userId: string) {
  const slug = uniqueId("org");
  const orgId = `org_${userId}`;
  setupClerkOrgMock({
    userId,
    orgId,
    memberships: [{ userId, role: "org:admin" }],
  });

  const createReq = createTestRequest("http://localhost:3000/api/org", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug }),
  });
  const res = await createOrgRoute(createReq);
  if (res.status !== 201) {
    const body = await res.json();
    throw new Error(`Failed to create org: ${body.error?.message}`);
  }

  return { slug, orgId };
}

describe("POST /api/org/invite - Invite Member", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/org/invite?scope=test",
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

  it("should require scope query parameter", async () => {
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
    expect(data.error.message).toContain("scope query parameter is required");
  });

  it("should invite member and return success message", async () => {
    const userId = uniqueId("invite-admin");
    const { slug } = await createOrg(userId);

    const inviteReq = createTestRequest(
      `http://localhost:3000/api/org/invite?scope=${slug}`,
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

  it("should create scope_members record when invitee has existing account", async () => {
    const userId = uniqueId("invite-admin2");
    const { slug } = await createOrg(userId);

    const inviteReq = createTestRequest(
      `http://localhost:3000/api/org/invite?scope=${slug}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "existing-user@example.com" }),
      },
    );
    const inviteRes = await POST(inviteReq);
    expect(inviteRes.status).toBe(200);

    // Verify scope_members record was created for the invitee
    // by listing scopes as the invited user — they should see the org scope.
    // The Clerk mock maps "existing-user@example.com" to userId "user_existing-user"
    mockClerk({ userId: "user_existing-user" });

    const listReq = createTestRequest("http://localhost:3000/api/scope/list");
    const listRes = await listScopesRoute(listReq);
    expect(listRes.status).toBe(200);

    const listData = await listRes.json();
    const orgScope = listData.scopes.find(
      (s: { slug: string }) => s.slug === slug,
    );
    expect(orgScope).toBeDefined();
    expect(orgScope.role).toBe("member");
  });
});
