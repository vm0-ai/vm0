import { describe, it, expect, beforeEach } from "vitest";
import { GET, POST } from "../route";
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

async function setupAdminOrg(userId: string) {
  const slug = uniqueId("zcc");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

async function setupMemberOrg(userId: string) {
  const slug = uniqueId("zcc");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:member" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function url(path = ""): string {
  return `http://localhost:3000/api/zero/custom-connectors${path}`;
}

async function expectUnauthorized(res: Response) {
  expect(res.status).toBe(401);
  await expect(res.json()).resolves.toStrictEqual({
    error: { message: "Not authenticated", code: "UNAUTHORIZED" },
  });
}

async function createSampleConnector(overrides: Record<string, unknown> = {}) {
  const body = {
    displayName: "Example",
    prefixes: ["https://api.example.com/"],
    headerName: "Authorization",
    headerTemplate: "Bearer {{secret}}",
    ...overrides,
  };
  const res = await POST(
    createTestRequest(url(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return res;
}

describe("GET /api/zero/custom-connectors", () => {
  beforeEach(() => {
    return context.setupMocks();
  });

  it("returns empty list when none exist", async () => {
    const userId = uniqueId("zcc-empty");
    await setupAdminOrg(userId);

    const res = await GET(createTestRequest(url(), { method: "GET" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.connectors).toEqual([]);
  });

  it("rejects unauthenticated requests", async () => {
    mockClerk({ userId: null });
    const res = await GET(createTestRequest(url(), { method: "GET" }));
    await expectUnauthorized(res);
  });

  it("returns 401 when authenticated without an active org", async () => {
    const userId = uniqueId("zcc-list-no-org");
    mockClerk({ userId, orgId: null });

    const res = await GET(createTestRequest(url(), { method: "GET" }));
    await expectUnauthorized(res);
  });

  it("lists created connectors with hasSecret flag", async () => {
    const userId = uniqueId("zcc-list");
    await setupAdminOrg(userId);

    const created = await createSampleConnector();
    expect(created.status).toBe(201);
    const connector = await created.json();

    const res = await GET(createTestRequest(url(), { method: "GET" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.connectors).toHaveLength(1);
    expect(data.connectors[0].id).toBe(connector.id);
    expect(data.connectors[0].displayName).toBe("Example");
    expect(data.connectors[0].hasSecret).toBe(false);
  });
});

describe("POST /api/zero/custom-connectors", () => {
  beforeEach(() => {
    return context.setupMocks();
  });

  it("rejects unauthenticated requests", async () => {
    mockClerk({ userId: null });

    const res = await createSampleConnector();
    await expectUnauthorized(res);
  });

  it("returns 401 when authenticated without an active org", async () => {
    const userId = uniqueId("zcc-create-no-org");
    mockClerk({ userId, orgId: null });

    const res = await createSampleConnector();
    await expectUnauthorized(res);
  });

  it("creates a connector as admin", async () => {
    const userId = uniqueId("zcc-create");
    await setupAdminOrg(userId);

    const res = await createSampleConnector();
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.slug).toMatch(/^api-example-com-/);
    expect(data.displayName).toBe("Example");
    expect(data.prefixes).toEqual(["https://api.example.com/"]);
    expect(data.hasSecret).toBe(false);
  });

  it("normalizes prefix to trailing slash", async () => {
    const userId = uniqueId("zcc-normalize");
    await setupAdminOrg(userId);

    const res = await createSampleConnector({
      prefixes: ["https://api.example.com/v1"],
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.prefixes).toEqual(["https://api.example.com/v1/"]);
  });

  it("accepts a host wildcard prefix and stores the user-facing value", async () => {
    const userId = uniqueId("zcc-wildcard");
    await setupAdminOrg(userId);

    const res = await createSampleConnector({
      prefixes: ["https://*.example.com/v1"],
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.slug).toMatch(/^example-com-/);
    expect(data.prefixes).toEqual(["https://*.example.com/v1/"]);
  });

  it("rejects non-admin members", async () => {
    const userId = uniqueId("zcc-member");
    await setupMemberOrg(userId);

    const res = await createSampleConnector();
    expect(res.status).toBe(403);
  });

  it("rejects missing {{secret}} placeholder", async () => {
    const userId = uniqueId("zcc-bad-template");
    await setupAdminOrg(userId);

    const res = await createSampleConnector({
      headerTemplate: "Bearer static-token",
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-https prefix", async () => {
    const userId = uniqueId("zcc-bad-prefix");
    await setupAdminOrg(userId);

    const res = await createSampleConnector({
      prefixes: ["http://api.example.com/"],
    });
    expect(res.status).toBe(400);
  });

  it("rejects prefix whose host collides with a built-in connector", async () => {
    const userId = uniqueId("zcc-host-conflict");
    await setupAdminOrg(userId);

    const res = await createSampleConnector({
      displayName: "Fake GitHub",
      prefixes: ["https://api.github.com/v3/"],
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    // Message should name both the conflicting host and the built-in connector
    // so the admin knows which built-in is shadowing their attempt.
    expect(data.error.message).toContain("api.github.com");
    expect(data.error.message).toContain("GitHub");
  });
});
