import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
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
import { server } from "../../../../../../src/mocks/server";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("mreq");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function membershipRequestsUrl(slug: string): string {
  return `http://localhost:3000/api/zero/org/membership-requests?org=${slug}`;
}

describe("POST /api/zero/org/membership-requests (accept)", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should accept a membership request for an admin", async () => {
    const userId = uniqueId("mreq-acc");
    const { orgId, slug } = await setupOrg(userId);

    server.use(
      http.post(
        `https://api.clerk.com/v1/organizations/${orgId}/membership_requests/req_test123/accept`,
        () => HttpResponse.json({}),
      ),
    );

    const response = await POST(
      createTestRequest(membershipRequestsUrl(slug), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "req_test123" }),
      }),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.message).toBe("Membership request accepted");
  });

  it("should return 400 when Clerk API rejects the accept request", async () => {
    const userId = uniqueId("mreq-acc-fail");
    const { orgId, slug } = await setupOrg(userId);

    server.use(
      http.post(
        `https://api.clerk.com/v1/organizations/${orgId}/membership_requests/req_invalid/accept`,
        () => HttpResponse.json({ error: "Not found" }, { status: 404 }),
      ),
    );

    const response = await POST(
      createTestRequest(membershipRequestsUrl(slug), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "req_invalid" }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it("should return 403 when caller is not an admin", async () => {
    const userId = uniqueId("mreq-acc-403");
    const slug = uniqueId("mreq-member");
    const orgId = `org_mock_${userId}`;
    mockClerk({ userId, orgId, orgRole: "org:member" });
    await createTestOrg(slug);

    const response = await POST(
      createTestRequest(membershipRequestsUrl(slug), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "req_test123" }),
      }),
    );

    expect(response.status).toBe(403);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await POST(
      createTestRequest(membershipRequestsUrl("any-org"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "req_test123" }),
      }),
    );

    expect(response.status).toBe(401);
  });
});

describe("DELETE /api/zero/org/membership-requests (reject)", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should reject a membership request for an admin", async () => {
    const userId = uniqueId("mreq-rej");
    const { orgId, slug } = await setupOrg(userId);

    server.use(
      http.post(
        `https://api.clerk.com/v1/organizations/${orgId}/membership_requests/req_test456/reject`,
        () => HttpResponse.json({}),
      ),
    );

    const response = await DELETE(
      createTestRequest(membershipRequestsUrl(slug), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "req_test456" }),
      }),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.message).toBe("Membership request rejected");
  });

  it("should return 400 when Clerk API rejects the reject request", async () => {
    const userId = uniqueId("mreq-rej-fail");
    const { orgId, slug } = await setupOrg(userId);

    server.use(
      http.post(
        `https://api.clerk.com/v1/organizations/${orgId}/membership_requests/req_invalid/reject`,
        () => HttpResponse.json({ error: "Not found" }, { status: 404 }),
      ),
    );

    const response = await DELETE(
      createTestRequest(membershipRequestsUrl(slug), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "req_invalid" }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it("should return 403 when caller is not an admin", async () => {
    const userId = uniqueId("mreq-rej-403");
    const slug = uniqueId("mreq-rej-member");
    const orgId = `org_mock_${userId}`;
    mockClerk({ userId, orgId, orgRole: "org:member" });
    await createTestOrg(slug);

    const response = await DELETE(
      createTestRequest(membershipRequestsUrl(slug), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "req_test456" }),
      }),
    );

    expect(response.status).toBe(403);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await DELETE(
      createTestRequest(membershipRequestsUrl("any-org"), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "req_test456" }),
      }),
    );

    expect(response.status).toBe(401);
  });
});
