import { describe, it, expect, beforeEach } from "vitest";
import { POST as createOrgRoute } from "../route";
import { GET } from "../status/route";
import { POST as switchScopeRoute } from "../../scope/use/route";
import { createTestRequest } from "../../../../src/__tests__/api-test-helpers";
import { testContext, uniqueId } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { setupClerkOrgMock } from "../../../../src/__tests__/org-test-helpers";

const context = testContext();

describe("GET /api/org/status - Organization Status", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest("http://localhost:3000/api/org/status");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should require org access token", async () => {
    await context.setupUser();

    const request = createTestRequest("http://localhost:3000/api/org/status");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error.message).toContain("Organization access token required");
  });

  it("should return org status with members", async () => {
    const user = await context.setupUser();
    const slug = uniqueId("org");
    const orgId = `org_${user.userId}`;
    setupClerkOrgMock({
      userId: user.userId,
      orgId,
      memberships: [{ userId: user.userId, role: "org:admin" }],
    });

    // Create org
    const createReq = createTestRequest("http://localhost:3000/api/org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const createRes = await createOrgRoute(createReq);
    expect(createRes.status).toBe(201);

    // Switch to org scope to get token
    const useReq = createTestRequest("http://localhost:3000/api/scope/use", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const useRes = await switchScopeRoute(useReq);
    const useData = await useRes.json();

    // Get org status with token
    const statusReq = createTestRequest(
      "http://localhost:3000/api/org/status",
      { headers: { Authorization: `Bearer ${useData.token}` } },
    );
    const statusRes = await GET(statusReq);
    expect(statusRes.status).toBe(200);

    const statusData = await statusRes.json();
    expect(statusData.slug).toBe(slug);
    expect(statusData.role).toBe("admin");
    expect(statusData.members).toHaveLength(1);
    expect(statusData.members[0].role).toBe("admin");
  });
});
