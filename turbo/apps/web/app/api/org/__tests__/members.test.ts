import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST as createOrgRoute } from "../route";
import { DELETE } from "../members/route";
import { GET as getOrgStatusRoute } from "../status/route";
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

    const request = createTestRequest(
      "http://localhost:3000/api/org/members?scope=test",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "member@example.com" }),
      },
    );
    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should require scope query parameter", async () => {
    await context.setupUser();

    const request = createTestRequest("http://localhost:3000/api/org/members", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "member@example.com" }),
    });
    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("scope query parameter is required");
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
      `http://localhost:3000/api/org/members?scope=${slug}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "member@example.com" }),
      },
    );
    const removeRes = await DELETE(removeReq);
    expect(removeRes.status).toBe(200);

    const removeData = await removeRes.json();
    expect(removeData.message).toContain("member@example.com");
  });

  it("should revoke member access after removal", async () => {
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

    // Verify member can access org status
    mockClerk({ userId: memberUserId });
    const statusReq1 = createTestRequest(
      `http://localhost:3000/api/org/status?scope=${slug}`,
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
      `http://localhost:3000/api/org/members?scope=${slug}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "member-revoke@example.com" }),
      },
    );
    const removeRes = await DELETE(removeReq);
    expect(removeRes.status).toBe(200);

    // Verify member can no longer access org status
    mockClerk({ userId: memberUserId });
    const statusReq2 = createTestRequest(
      `http://localhost:3000/api/org/status?scope=${slug}`,
    );
    const statusRes2 = await getOrgStatusRoute(statusReq2);
    // After removal, the member should get 403 (not a member) or 404
    expect([403, 404]).toContain(statusRes2.status);
  });
});
