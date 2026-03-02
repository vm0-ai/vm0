import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST as createOrgRoute } from "../route";
import { DELETE } from "../members/route";
import { GET as getOrgStatusRoute } from "../status/route";
import { POST as switchScopeRoute } from "../../scope/use/route";
import { createTestRequest } from "../../../../src/__tests__/api-test-helpers";
import { testContext, uniqueId } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { setupClerkOrgMock } from "../../../../src/__tests__/org-test-helpers";
import { clerkClient } from "@clerk/nextjs/server";

const context = testContext();

describe("DELETE /api/org/members - Remove Member", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest("http://localhost:3000/api/org/members", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "member@example.com" }),
    });
    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should require org access token", async () => {
    await context.setupUser();

    const request = createTestRequest("http://localhost:3000/api/org/members", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "member@example.com" }),
    });
    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error.message).toContain("Organization access token required");
  });

  it("should remove member and return success message", async () => {
    const user = await context.setupUser();
    const slug = uniqueId("org");
    const memberUserId = uniqueId("member");
    const orgId = `org_${user.userId}`;

    setupClerkOrgMock({
      userId: user.userId,
      orgId,
      memberships: [
        { userId: user.userId, role: "org:admin" },
        { userId: memberUserId, role: "org:member" },
      ],
    });

    // Create org
    const createReq = createTestRequest("http://localhost:3000/api/org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const createRes = await createOrgRoute(createReq);
    expect(createRes.status).toBe(201);

    // Switch to org scope
    const useReq = createTestRequest("http://localhost:3000/api/scope/use", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const useRes = await switchScopeRoute(useReq);
    const useData = await useRes.json();

    // Override getUserList to return the exact memberUserId for the email
    const client = await clerkClient();
    vi.mocked(client.users.getUserList).mockResolvedValue({
      data: [
        {
          id: memberUserId,
          emailAddresses: [
            { id: "email_1", emailAddress: "member@example.com" },
          ],
          primaryEmailAddressId: "email_1",
        },
      ],
    } as unknown as Awaited<ReturnType<typeof client.users.getUserList>>);

    const removeReq = createTestRequest(
      "http://localhost:3000/api/org/members",
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${useData.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: "member@example.com" }),
      },
    );
    const removeRes = await DELETE(removeReq);
    expect(removeRes.status).toBe(200);

    const removeData = await removeRes.json();
    expect(removeData.message).toContain("member@example.com");
  });

  it("should revoke member tokens after removal", async () => {
    const user = await context.setupUser();
    const slug = uniqueId("org");
    const memberUserId = uniqueId("member");
    const orgId = `org_${user.userId}`;

    setupClerkOrgMock({
      userId: user.userId,
      orgId,
      memberships: [
        { userId: user.userId, role: "org:admin" },
        { userId: memberUserId, role: "org:member" },
      ],
    });

    // Create org
    const createReq = createTestRequest("http://localhost:3000/api/org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const createRes = await createOrgRoute(createReq);
    expect(createRes.status).toBe(201);

    // Generate token for member by simulating scope use
    mockClerk({ userId: memberUserId });
    setupClerkOrgMock({
      userId: memberUserId,
      orgId,
      memberships: [
        { userId: user.userId, role: "org:admin" },
        { userId: memberUserId, role: "org:member" },
      ],
    });

    const memberUseReq = createTestRequest(
      "http://localhost:3000/api/scope/use",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      },
    );
    const memberUseRes = await switchScopeRoute(memberUseReq);
    expect(memberUseRes.status).toBe(200);
    const memberUseData = await memberUseRes.json();
    const memberOrgToken = memberUseData.token;

    // Verify member token is valid via API
    const statusReq1 = createTestRequest(
      "http://localhost:3000/api/org/status",
      { headers: { Authorization: `Bearer ${memberOrgToken}` } },
    );
    const statusRes1 = await getOrgStatusRoute(statusReq1);
    expect(statusRes1.status).toBe(200);

    // Switch back to admin and remove the member
    setupClerkOrgMock({
      userId: user.userId,
      orgId,
      memberships: [
        { userId: user.userId, role: "org:admin" },
        { userId: memberUserId, role: "org:member" },
      ],
    });

    const adminUseReq = createTestRequest(
      "http://localhost:3000/api/scope/use",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      },
    );
    const adminUseRes = await switchScopeRoute(adminUseReq);
    const adminUseData = await adminUseRes.json();

    // Override getUserList to return memberUserId for the email
    const adminClient = await clerkClient();
    vi.mocked(adminClient.users.getUserList).mockResolvedValue({
      data: [
        {
          id: memberUserId,
          emailAddresses: [
            { id: "email_1", emailAddress: "member-revoke@example.com" },
          ],
          primaryEmailAddressId: "email_1",
        },
      ],
    } as unknown as Awaited<ReturnType<typeof adminClient.users.getUserList>>);

    const removeReq = createTestRequest(
      "http://localhost:3000/api/org/members",
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${adminUseData.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: "member-revoke@example.com" }),
      },
    );
    const removeRes = await DELETE(removeReq);
    expect(removeRes.status).toBe(200);

    // Verify member's token is now revoked via API
    // Need to re-mock clerk for the member context since resolveOrgAccessToken
    // will look up the user
    mockClerk({ userId: memberUserId });
    const statusReq2 = createTestRequest(
      "http://localhost:3000/api/org/status",
      { headers: { Authorization: `Bearer ${memberOrgToken}` } },
    );
    const statusRes2 = await getOrgStatusRoute(statusReq2);
    expect(statusRes2.status).toBe(401);

    const statusData2 = await statusRes2.json();
    expect(statusData2.error.message).toContain("Invalid or expired org token");
  });
});
