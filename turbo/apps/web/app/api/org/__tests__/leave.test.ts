import { describe, it, expect, beforeEach, vi } from "vitest";
import { auth } from "@clerk/nextjs/server";
import { POST } from "../leave/route";
import {
  createTestRequest,
  createTestOrg as createTestOrgHelper,
  insertOrgMembersCacheEntry,
  findOrgMembersCacheEntry,
  createTestSlackOrgInstallation,
  createTestSlackOrgConnection,
  findTestSlackOrgConnection,
} from "../../../../src/__tests__/api-test-helpers";
import { testContext, uniqueId } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { setupClerkOrgMock } from "../../../../src/__tests__/clerk-org-mock";

const context = testContext();

describe("POST /api/org/leave - Leave Org", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/org/leave?org=test",
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

    const request = createTestRequest("http://localhost:3000/api/org/leave", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should allow member to leave and clean up org member cache", async () => {
    const adminUserId = uniqueId("leave-admin");
    const memberUserId = uniqueId("leave-member");
    const slug = uniqueId("org");
    setupClerkOrgMock({
      userId: memberUserId,
      orgSlug: slug,
      memberships: [
        { userId: adminUserId, role: "org:admin" },
        { userId: memberUserId, role: "org:member" },
      ],
    });

    // Create org — capture the actual orgId from the helper (auth() returns memberUserId)
    const { id: orgId } = await createTestOrgHelper(slug);

    // Override auth to return org:member role so leaveOrg does not throw forbidden
    vi.mocked(auth).mockResolvedValue({
      userId: memberUserId,
      orgId,
      orgRole: "org:member",
      sessionClaims: {},
    } as unknown as Awaited<ReturnType<typeof auth>>);

    // Seed an org members cache row and a Slack connection for the member
    await insertOrgMembersCacheEntry({
      orgId,
      userId: memberUserId,
      role: "member",
    });
    const { slackWorkspaceId } = await createTestSlackOrgInstallation({
      orgId,
    });
    const { slackUserId } = await createTestSlackOrgConnection({
      slackWorkspaceId,
      vm0UserId: memberUserId,
    });

    // Verify both rows exist before leaving
    const cacheBefore = await findOrgMembersCacheEntry(orgId, memberUserId);
    expect(cacheBefore).toBeDefined();
    const connectionBefore = await findTestSlackOrgConnection(
      slackUserId,
      slackWorkspaceId,
    );
    expect(connectionBefore).toBeDefined();

    // Member leaves the org
    const leaveReq = createTestRequest(
      `http://localhost:3000/api/org/leave?org=${slug}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const leaveRes = await POST(leaveReq);
    expect(leaveRes.status).toBe(200);

    const leaveData = await leaveRes.json();
    expect(leaveData.message).toBeDefined();

    // Verify both rows were deleted by cleanupOrgMember
    const cacheAfter = await findOrgMembersCacheEntry(orgId, memberUserId);
    expect(cacheAfter).toBeUndefined();
    const connectionAfter = await findTestSlackOrgConnection(
      slackUserId,
      slackWorkspaceId,
    );
    expect(connectionAfter).toBeUndefined();
  });

  it("should prevent admin from leaving", async () => {
    const userId = uniqueId("leave-admin");
    const slug = uniqueId("org");
    setupClerkOrgMock({
      userId,
      orgSlug: slug,
      memberships: [{ userId, role: "org:admin" }],
    });

    // Create org
    await createTestOrgHelper(slug);

    // Try to leave as admin
    const leaveReq = createTestRequest(
      `http://localhost:3000/api/org/leave?org=${slug}`,
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
