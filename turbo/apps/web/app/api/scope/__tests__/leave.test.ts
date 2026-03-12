import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../leave/route";
import {
  createTestRequest,
  createTestOrg as createTestOrgHelper,
} from "../../../../src/__tests__/api-test-helpers";
import { testContext, uniqueId } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { setupClerkOrgMock } from "../../../../src/__tests__/clerk-org-mock";

const context = testContext();

describe("POST /api/scope/leave - Leave Org", () => {
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

  it("should require org query parameter", async () => {
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
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should prevent admin from leaving", async () => {
    const userId = uniqueId("leave-admin");
    const slug = uniqueId("org");
    const orgId = `org_${userId}`;
    setupClerkOrgMock({
      userId,
      orgId,
      orgSlug: slug,
      memberships: [{ userId, role: "org:admin" }],
    });

    // Create org
    await createTestOrgHelper(slug);

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
    expect(leaveData.error.code).toBe("FORBIDDEN");
  });
});
