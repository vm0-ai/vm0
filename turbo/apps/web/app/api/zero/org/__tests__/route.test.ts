import { describe, it, expect, beforeEach } from "vitest";
import { GET, PUT } from "../route";
import {
  createTestRequest,
  createTestOrg,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zorg");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function orgUrl(): string {
  return `http://localhost:3000/api/zero/org`;
}

describe("GET /api/zero/org", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return org info", async () => {
    const userId = uniqueId("zorg-get");
    const { slug } = await setupOrg(userId);

    const response = await GET(createTestRequest(orgUrl()));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.id).toBeDefined();
    expect(data.slug).toBe(slug);
    expect(data.name).toBeDefined();
  });

  it("should return 404 when org not found", async () => {
    const userId = uniqueId("zorg-nf");
    mockClerk({
      userId,
      orgId: `org_mock_${userId}`,
      orgRole: "org:admin",
      clerkOrgs: [],
    });

    const response = await GET(createTestRequest(orgUrl()));
    expect(response.status).toBe(404);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest("http://localhost:3000/api/zero/org"),
    );
    expect(response.status).toBe(401);
  });
});

describe("PUT /api/zero/org", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should update org name and return 200", async () => {
    const userId = uniqueId("zorg-upd");
    await setupOrg(userId);

    const response = await PUT(
      createTestRequest(orgUrl(), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated Org Name" }),
      }),
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.id).toBeDefined();
    expect(data.slug).toBeDefined();
    expect(data.name).toBeDefined();
  });

  it("should return 400 when changing slug without force", async () => {
    const userId = uniqueId("zorg-noforce");
    await setupOrg(userId);

    const response = await PUT(
      createTestRequest(orgUrl(), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "new-slug-name" }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await PUT(
      createTestRequest("http://localhost:3000/api/zero/org", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test" }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("should return 404 when org not found", async () => {
    const userId = uniqueId("zorg-upd-nf");
    mockClerk({
      userId,
      orgId: `org_mock_${userId}`,
      orgRole: "org:admin",
      clerkOrgs: [],
    });

    const response = await PUT(
      createTestRequest(orgUrl(), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test" }),
      }),
    );
    expect(response.status).toBe(404);
  });
});
