import { describe, it, expect, beforeEach } from "vitest";
import { POST as createScopeRoute } from "../route";
import { POST } from "../leave/route";
import { createTestRequest } from "../../../../src/__tests__/api-test-helpers";
import { testContext, uniqueId } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { setupClerkOrgMock } from "../../../../src/__tests__/clerk-org-mock";

const context = testContext();

describe("POST /api/scope/leave - Leave Scope", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/scope/leave?scope=test",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should require scope query parameter", async () => {
    const userId = uniqueId("leave-user");
    mockClerk({ userId });

    const request = createTestRequest("http://localhost:3000/api/scope/leave", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain(
      "scope or org query parameter is required",
    );
  });

  it("should prevent admin from leaving", async () => {
    const userId = uniqueId("leave-admin");
    const slug = uniqueId("scope");
    const orgId = `org_${userId}`;
    setupClerkOrgMock({
      userId,
      orgId,
      orgSlug: slug,
      memberships: [{ userId, role: "org:admin" }],
    });

    // Create scope
    const createReq = createTestRequest("http://localhost:3000/api/scope", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const createRes = await createScopeRoute(createReq);
    expect(createRes.status).toBe(201);

    // Try to leave as admin
    const leaveReq = createTestRequest(
      `http://localhost:3000/api/scope/leave?scope=${slug}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const leaveRes = await POST(leaveReq);
    expect(leaveRes.status).toBe(403);

    const leaveData = await leaveRes.json();
    expect(leaveData.error.message).toContain("Admin");
  });
});
