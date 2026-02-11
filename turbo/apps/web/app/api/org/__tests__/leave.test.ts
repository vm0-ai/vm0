import { describe, it, expect, beforeEach } from "vitest";
import { POST as createOrgRoute } from "../route";
import { POST } from "../leave/route";
import { POST as switchScopeRoute } from "../../scope/use/route";
import { createTestRequest } from "../../../../src/__tests__/api-test-helpers";
import { testContext, uniqueId } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { setupClerkOrgMock } from "../../../../src/__tests__/org-test-helpers";

const context = testContext();

describe("POST /api/org/leave - Leave Organization", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest("http://localhost:3000/api/org/leave", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should require org access token", async () => {
    await context.setupUser();

    const request = createTestRequest("http://localhost:3000/api/org/leave", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error.message).toContain("Organization access token required");
  });

  it("should prevent admin from leaving", async () => {
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
    await createOrgRoute(createReq);

    // Switch to org scope
    const useReq = createTestRequest("http://localhost:3000/api/scope/use", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const useRes = await switchScopeRoute(useReq);
    const useData = await useRes.json();

    // Try to leave as admin
    const leaveReq = createTestRequest("http://localhost:3000/api/org/leave", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${useData.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const leaveRes = await POST(leaveReq);
    expect(leaveRes.status).toBe(403);

    const leaveData = await leaveRes.json();
    expect(leaveData.error.message).toContain("Admin");
  });
});
