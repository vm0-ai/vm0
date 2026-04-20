import { describe, it, expect, beforeEach } from "vitest";
import { GET, PUT } from "../route";
import {
  createTestRequest,
  createTestOrg,
  insertOrgMembersCacheEntry,
  updateOrgTier,
  ensureOrgRow,
  insertOrgCacheEntry,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { generateZeroToken } from "../../../../../src/lib/auth/sandbox-token";

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

function testOrgs(...slugs: string[]) {
  return slugs.map((slug) => {
    return {
      id: `org_mock_${slug}`,
      slug,
      name: slug,
    };
  });
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

  it("should return 404 when no org in session", async () => {
    const userId = uniqueId("zorg-nf");
    mockClerk({
      userId,
      orgId: null,
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

  it("should return org info with zero token", async () => {
    mockClerk({ userId: null });
    const userId = uniqueId("zorg-zero");
    const { slug, orgId } = await setupOrg(userId);
    await insertOrgMembersCacheEntry({ orgId, userId, role: "admin" });

    const token = await generateZeroToken(userId, "run-123", orgId);
    const response = await GET(
      createTestRequest(orgUrl(), {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.slug).toBe(slug);
    expect(data.role).toBe("admin");
  });
});

describe("GET /api/zero/org — org resolution", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should resolve org from session context", async () => {
    const userId = uniqueId("zorg-resolve");
    const slug = uniqueId("org");

    mockClerk({ userId, clerkOrgs: testOrgs(slug) });
    const { id: orgId } = await createTestOrg(slug);

    mockClerk({ userId, orgId, clerkOrgs: testOrgs(slug) });

    const response = await GET(createTestRequest(orgUrl()));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(orgId);
  });

  it("should return 404 when no org context available", async () => {
    const userId = uniqueId("zorg-noctx");

    mockClerk({ userId, orgId: null, clerkOrgs: [] });

    const response = await GET(createTestRequest(orgUrl()));

    expect(response.status).toBe(404);
  });

  it("should resolve correct org when user has multiple orgs", async () => {
    const userId = uniqueId("zorg-multi");
    const slug1 = uniqueId("org");
    const slug2 = uniqueId("org");

    mockClerk({ userId, clerkOrgs: testOrgs(slug1, slug2) });
    const { id: orgId1 } = await createTestOrg(slug1);

    const orgId2 = `org_mock_${slug2}`;
    await ensureOrgRow(orgId2);
    await insertOrgCacheEntry({ orgId: orgId2, slug: slug2, name: slug2 });

    mockClerk({
      userId,
      orgId: orgId2,
      clerkOrgs: [
        { id: orgId1, slug: slug1, name: slug1 },
        { id: orgId2, slug: slug2, name: slug2 },
      ],
    });

    const response = await GET(createTestRequest(orgUrl()));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(orgId2);
    expect(data.id).not.toBe(orgId1);
  });

  it("should return tier from org table", async () => {
    const userId = uniqueId("zorg-tier");
    const { orgId } = await setupOrg(userId);

    await updateOrgTier(orgId, "pro");

    const response = await GET(createTestRequest(orgUrl()));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(orgId);
    expect(data.tier).toBe("pro");
  });

  it("should return default free tier for new org", async () => {
    const userId = uniqueId("zorg-free");
    await setupOrg(userId);

    const response = await GET(createTestRequest(orgUrl()));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.tier).toBe("free");
  });

  it("should reflect updated tier value", async () => {
    const userId = uniqueId("zorg-tierchg");
    const { orgId } = await setupOrg(userId);

    const response1 = await GET(createTestRequest(orgUrl()));
    const data1 = await response1.json();
    expect(data1.tier).toBe("free");

    await updateOrgTier(orgId, "team");

    const response2 = await GET(createTestRequest(orgUrl()));
    const data2 = await response2.json();
    expect(data2.tier).toBe("team");
  });

  it("should return free tier for brand-new org without metadata", async () => {
    const userId = uniqueId("zorg-brand");
    const orgId = uniqueId("brand-new-org");
    const slug = uniqueId("org");

    await insertOrgCacheEntry({ orgId, slug, name: slug });
    mockClerk({ userId, orgId, clerkOrgs: [{ id: orgId, slug, name: slug }] });

    const response = await GET(createTestRequest(orgUrl()));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(orgId);
    expect(data.tier).toBe("free");
  });

  it("should return member with correct role", async () => {
    const userId = uniqueId("zorg-role");
    await setupOrg(userId);

    const response = await GET(createTestRequest(orgUrl()));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.role).toBe("admin");
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

  it("should return 400 when no org in session", async () => {
    const userId = uniqueId("zorg-upd-nf");
    mockClerk({
      userId,
      orgId: null,
      clerkOrgs: [],
    });

    const response = await PUT(
      createTestRequest(orgUrl(), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test" }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("should reject zero token for PUT", async () => {
    mockClerk({ userId: null });
    const userId = uniqueId("zorg-put-zero");
    const { orgId } = await setupOrg(userId);
    await insertOrgMembersCacheEntry({ orgId, userId, role: "admin" });

    const token = await generateZeroToken(userId, "run-123", orgId);
    const response = await PUT(
      createTestRequest(orgUrl(), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Hacked" }),
      }),
    );
    expect(response.status).toBe(403);
  });
});
