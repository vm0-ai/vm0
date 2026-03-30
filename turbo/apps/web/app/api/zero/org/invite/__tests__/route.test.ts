import { describe, it, expect, beforeEach } from "vitest";
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

function inviteUrl(slug: string): string {
  return `http://localhost:3000/api/zero/org/invite?org=${slug}`;
}

describe("POST /api/zero/org/invite (invite)", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should invite a member for an admin", async () => {
    const userId = uniqueId("inv-ok");
    const { slug } = await setupOrg(userId);

    const response = await POST(
      createTestRequest(inviteUrl(slug), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "newuser@example.com" }),
      }),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.message).toContain("newuser@example.com");
  });

  it("should return 403 when caller is not an admin", async () => {
    const userId = uniqueId("inv-403");
    const slug = uniqueId("inv-member");
    const orgId = `org_mock_${userId}`;
    mockClerk({ userId, orgId, orgRole: "org:member" });
    await createTestOrg(slug);

    const response = await POST(
      createTestRequest(inviteUrl(slug), {
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
      createTestRequest(inviteUrl("any-org"), {
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
    const { slug } = await setupOrg(userId);

    const response = await DELETE(
      createTestRequest(inviteUrl(slug), {
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
      createTestRequest(inviteUrl(slug), {
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
      createTestRequest(inviteUrl("any-org"), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitationId: "inv_test123" }),
      }),
    );

    expect(response.status).toBe(401);
  });

  it("should return 404 when org not found", async () => {
    const userId = uniqueId("rev-nf");
    mockClerk({ userId, orgId: `org_mock_${userId}`, orgRole: "org:admin" });

    const response = await DELETE(
      createTestRequest(inviteUrl("nonexistent-org-slug"), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitationId: "inv_test123" }),
      }),
    );

    expect(response.status).toBe(404);
  });
});
