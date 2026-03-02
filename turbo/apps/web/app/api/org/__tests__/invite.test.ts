import { describe, it, expect, beforeEach } from "vitest";
import { POST as createOrgRoute } from "../route";
import { POST } from "../invite/route";
import { POST as switchScopeRoute } from "../../scope/use/route";
import { createTestRequest } from "../../../../src/__tests__/api-test-helpers";
import { testContext, uniqueId } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { setupClerkOrgMock } from "../../../../src/__tests__/org-test-helpers";

const context = testContext();

/**
 * Helper to create an org and get an org access token.
 */
async function createOrgAndGetToken(userId: string) {
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
  await createOrgRoute(createReq);

  const useReq = createTestRequest("http://localhost:3000/api/scope/use", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug }),
  });
  const useRes = await switchScopeRoute(useReq);
  const useData = await useRes.json();
  return { slug, orgId, token: useData.token as string };
}

describe("POST /api/org/invite - Invite Member", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest("http://localhost:3000/api/org/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "member@example.com" }),
    });
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should require org access token", async () => {
    await context.setupUser();

    const request = createTestRequest("http://localhost:3000/api/org/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "member@example.com" }),
    });
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error.message).toContain("Organization access token required");
  });

  it("should invite member and return success message", async () => {
    const user = await context.setupUser();
    const { token } = await createOrgAndGetToken(user.userId);

    const inviteReq = createTestRequest(
      "http://localhost:3000/api/org/invite",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: "new-member@example.com" }),
      },
    );
    const inviteRes = await POST(inviteReq);
    expect(inviteRes.status).toBe(200);

    const inviteData = await inviteRes.json();
    expect(inviteData.message).toContain("new-member@example.com");
  });
});
