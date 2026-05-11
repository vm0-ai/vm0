import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { GET } from "../route";
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
  const slug = uniqueId("mem");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function membersUrl(): string {
  return `http://localhost:3000/api/zero/org/members`;
}

describe("GET /api/zero/org/members", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return members list for an admin", async () => {
    const userId = uniqueId("mem-get");
    const { orgId } = await setupOrg(userId);

    server.use(
      http.get(
        `https://api.clerk.com/v1/organizations/${orgId}/membership_requests`,
        () => {
          return HttpResponse.json({ data: [] });
        },
      ),
    );

    const response = await GET(createTestRequest(membersUrl()));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.members).toBeInstanceOf(Array);
    expect(data.role).toBe("admin");
    expect(data.membershipRequests).toBeInstanceOf(Array);
  });

  it("should include membership requests when pending requests exist", async () => {
    const userId = uniqueId("mem-mreq");
    const { orgId } = await setupOrg(userId);
    const requestUserId = `req-user-${userId}`;

    server.use(
      http.get(
        `https://api.clerk.com/v1/organizations/${orgId}/membership_requests`,
        () => {
          return HttpResponse.json({
            data: [
              {
                id: "req_test_1",
                public_user_data: { user_id: requestUserId },
                created_at: Date.now(),
              },
            ],
          });
        },
      ),
    );

    const response = await GET(createTestRequest(membersUrl()));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.membershipRequests).toBeInstanceOf(Array);
    expect(data.membershipRequests).toHaveLength(1);
    expect(data.membershipRequests[0].id).toBe("req_test_1");
    expect(data.membershipRequests[0].userId).toBe(requestUserId);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(createTestRequest(membersUrl()));

    expect(response.status).toBe(401);
  });

  it("should return 401 when no org in session", async () => {
    const userId = uniqueId("mem-nf");
    mockClerk({
      userId,
      orgId: null,
      clerkOrgs: [],
    });

    const response = await GET(createTestRequest(membersUrl()));

    expect(response.status).toBe(401);
  });

  it("should not expose pendingInvitations or membershipRequests to non-admin members", async () => {
    const userId = uniqueId("mem-nonadmin");
    const slug = uniqueId("mem-nonadmin");
    const orgId = `org_mock_${userId}`;
    mockClerk({
      userId,
      orgId,
      orgRole: "org:member",
      clerkOrgs: [{ id: orgId, slug, name: slug, role: "org:member" }],
    });
    await createTestOrg(slug);

    const response = await GET(createTestRequest(membersUrl()));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.role).toBe("member");
    expect(data.pendingInvitations).toEqual([]);
    expect(data.membershipRequests).toEqual([]);
  });
});
