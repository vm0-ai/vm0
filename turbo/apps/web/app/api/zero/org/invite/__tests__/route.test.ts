import { describe, it, expect, beforeEach } from "vitest";
import { clerkClient } from "@clerk/nextjs/server";
import { POST, DELETE } from "../route";
import {
  createTestRequest,
  createTestOrg,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("inv");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function inviteUrl(): string {
  return `http://localhost:3000/api/zero/org/invite`;
}

describe("POST /api/zero/org/invite (invite)", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should invite a member with default role", async () => {
    const userId = uniqueId("inv-ok");
    await setupOrg(userId);

    const response = await POST(
      createTestRequest(inviteUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "newuser@example.com" }),
      }),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.message).toContain("newuser@example.com");

    const client = await clerkClient();
    expect(
      client.organizations.createOrganizationInvitation,
    ).toHaveBeenCalledWith(expect.objectContaining({ role: "org:member" }));
  });

  it("should invite a member with admin role", async () => {
    const userId = uniqueId("inv-admin");
    await setupOrg(userId);

    const response = await POST(
      createTestRequest(inviteUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@example.com", role: "admin" }),
      }),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.message).toContain("admin@example.com");

    const client = await clerkClient();
    expect(
      client.organizations.createOrganizationInvitation,
    ).toHaveBeenCalledWith(expect.objectContaining({ role: "org:admin" }));
  });

  it("should return 403 when caller is not an admin", async () => {
    const userId = uniqueId("inv-403");
    const slug = uniqueId("inv-member");
    const orgId = `org_mock_${userId}`;
    mockClerk({ userId, orgId, orgRole: "org:member" });
    await createTestOrg(slug);

    const response = await POST(
      createTestRequest(inviteUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "newuser@example.com" }),
      }),
    );

    expect(response.status).toBe(403);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await POST(
      createTestRequest(inviteUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "newuser@example.com" }),
      }),
    );

    expect(response.status).toBe(401);
  });
});

describe("DELETE /api/zero/org/invite (revoke)", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should revoke an invitation for an admin", async () => {
    const userId = uniqueId("rev-ok");
    await setupOrg(userId);

    const response = await DELETE(
      createTestRequest(inviteUrl(), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitationId: "inv_test123" }),
      }),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.message).toBe("Invitation revoked");
  });

  it("should return 403 when caller is not an admin", async () => {
    const userId = uniqueId("rev-403");
    const slug = uniqueId("inv-member");
    const orgId = `org_mock_${userId}`;
    mockClerk({ userId, orgId, orgRole: "org:member" });
    await createTestOrg(slug);

    const response = await DELETE(
      createTestRequest(inviteUrl(), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitationId: "inv_test123" }),
      }),
    );

    expect(response.status).toBe(403);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await DELETE(
      createTestRequest(inviteUrl(), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitationId: "inv_test123" }),
      }),
    );

    expect(response.status).toBe(401);
  });

  it("should return 400 when no org in session", async () => {
    const userId = uniqueId("rev-nf");
    mockClerk({
      userId,
      orgId: null,
      clerkOrgs: [],
    });

    const response = await DELETE(
      createTestRequest(inviteUrl(), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitationId: "inv_test123" }),
      }),
    );

    expect(response.status).toBe(400);
  });
});
