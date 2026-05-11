import { describe, it, expect, beforeEach } from "vitest";
import { GET, POST, DELETE, PATCH } from "../route";
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
  const slug = uniqueId("dom");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function domainsUrl(): string {
  return `http://localhost:3000/api/zero/org/domains`;
}

describe("GET /api/zero/org/domains", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return domain list for an admin", async () => {
    const userId = uniqueId("dom-get");
    await setupOrg(userId);

    const response = await GET(createTestRequest(domainsUrl()));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.domains).toBeInstanceOf(Array);
  });

  it("should return 403 when caller is not an admin", async () => {
    const userId = uniqueId("dom-get-403");
    const slug = uniqueId("dom-member");
    const orgId = `org_mock_${userId}`;
    mockClerk({ userId, orgId, orgRole: "org:member" });
    await createTestOrg(slug);

    const response = await GET(createTestRequest(domainsUrl()));

    expect(response.status).toBe(403);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(createTestRequest(domainsUrl()));

    expect(response.status).toBe(401);
  });

  it("should return 401 when no org in session", async () => {
    const userId = uniqueId("dom-no-org");
    mockClerk({ userId, orgId: null, clerkOrgs: [] });

    const response = await GET(createTestRequest(domainsUrl()));

    expect(response.status).toBe(401);
  });
});

describe("POST /api/zero/org/domains", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should add a domain for an admin", async () => {
    const userId = uniqueId("dom-add");
    await setupOrg(userId);

    const response = await POST(
      createTestRequest(domainsUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "example.com",
          enrollmentMode: "manual_invitation",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.message).toContain("example.com");
  });

  it("should return 403 when caller is not an admin", async () => {
    const userId = uniqueId("dom-add-403");
    const slug = uniqueId("dom-add-member");
    const orgId = `org_mock_${userId}`;
    mockClerk({ userId, orgId, orgRole: "org:member" });
    await createTestOrg(slug);

    const response = await POST(
      createTestRequest(domainsUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "example.com",
          enrollmentMode: "manual_invitation",
        }),
      }),
    );

    expect(response.status).toBe(403);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await POST(
      createTestRequest(domainsUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "example.com",
          enrollmentMode: "manual_invitation",
        }),
      }),
    );

    expect(response.status).toBe(401);
  });
});

describe("DELETE /api/zero/org/domains", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should remove a domain for an admin", async () => {
    const userId = uniqueId("dom-del");
    await setupOrg(userId);

    const response = await DELETE(
      createTestRequest(domainsUrl(), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domainId: "domain_test123" }),
      }),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.message).toBe("Domain removed");
  });

  it("should return 403 when caller is not an admin", async () => {
    const userId = uniqueId("dom-del-403");
    const slug = uniqueId("dom-del-member");
    const orgId = `org_mock_${userId}`;
    mockClerk({ userId, orgId, orgRole: "org:member" });
    await createTestOrg(slug);

    const response = await DELETE(
      createTestRequest(domainsUrl(), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domainId: "domain_test123" }),
      }),
    );

    expect(response.status).toBe(403);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await DELETE(
      createTestRequest(domainsUrl(), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domainId: "domain_test123" }),
      }),
    );

    expect(response.status).toBe(401);
  });
});

describe("PATCH /api/zero/org/domains (setVerified)", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should verify a domain for an admin", async () => {
    const userId = uniqueId("dom-verify");
    await setupOrg(userId);

    const response = await PATCH(
      createTestRequest(domainsUrl(), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domainId: "domain_test123", verified: true }),
      }),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.message).toBe("Domain verified");
  });

  it("should unverify a domain for an admin", async () => {
    const userId = uniqueId("dom-unverify");
    await setupOrg(userId);

    const response = await PATCH(
      createTestRequest(domainsUrl(), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domainId: "domain_test123", verified: false }),
      }),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.message).toBe("Domain unverified");
  });

  it("should return 403 when caller is not an admin", async () => {
    const userId = uniqueId("dom-verify-403");
    const slug = uniqueId("dom-verify-member");
    const orgId = `org_mock_${userId}`;
    mockClerk({ userId, orgId, orgRole: "org:member" });
    await createTestOrg(slug);

    const response = await PATCH(
      createTestRequest(domainsUrl(), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domainId: "domain_test123", verified: true }),
      }),
    );

    expect(response.status).toBe(403);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await PATCH(
      createTestRequest(domainsUrl(), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domainId: "domain_test123", verified: true }),
      }),
    );

    expect(response.status).toBe(401);
  });
});
