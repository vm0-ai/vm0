import { describe, it, expect, beforeEach } from "vitest";
import { GET, POST } from "../route";
import { DELETE as DELETE_BY_ID, PATCH as PATCH_BY_ID } from "../[id]/route";
import {
  PUT as PUT_SECRET,
  DELETE as DELETE_SECRET,
} from "../[id]/secret/route";
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
    expect(res.status).toBe(401);
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

describe("DELETE /api/zero/custom-connectors/:id", () => {
  beforeEach(() => {
    return context.setupMocks();
  });

  it("deletes connector as admin and cascades secrets", async () => {
    const userId = uniqueId("zcc-delete");
    await setupAdminOrg(userId);

    const created = await createSampleConnector();
    const { id } = await created.json();

    // Set a secret first
    const setRes = await PUT_SECRET(
      createTestRequest(url(`/${id}/secret`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "sk_test_abc123" }),
      }),
    );
    expect(setRes.status).toBe(204);

    // Delete the connector
    const delRes = await DELETE_BY_ID(
      createTestRequest(url(`/${id}`), { method: "DELETE" }),
    );
    expect(delRes.status).toBe(204);

    // List should now be empty
    const listRes = await GET(createTestRequest(url(), { method: "GET" }));
    const listData = await listRes.json();
    expect(listData.connectors).toEqual([]);
  });

  it("rejects non-admin deletion", async () => {
    const adminId = uniqueId("zcc-delete-admin");
    await setupAdminOrg(adminId);
    const created = await createSampleConnector();
    const { id } = await created.json();

    // Switch to member in the same org
    mockClerk({
      userId: uniqueId("zcc-delete-member"),
      orgId: `org_mock_${adminId}`,
      orgRole: "org:member",
    });

    const delRes = await DELETE_BY_ID(
      createTestRequest(url(`/${id}`), { method: "DELETE" }),
    );
    expect(delRes.status).toBe(403);
  });
});

describe("PATCH /api/zero/custom-connectors/:id", () => {
  beforeEach(() => {
    return context.setupMocks();
  });

  it("renames a connector as admin", async () => {
    const userId = uniqueId("zcc-patch");
    await setupAdminOrg(userId);
    const created = await createSampleConnector();
    const { id } = await created.json();

    const res = await PATCH_BY_ID(
      createTestRequest(url(`/${id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Renamed" }),
      }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(id);
    expect(data.displayName).toBe("Renamed");

    // GET should reflect the rename.
    const listRes = await GET(createTestRequest(url(), { method: "GET" }));
    const listData = await listRes.json();
    expect(listData.connectors[0].displayName).toBe("Renamed");
  });

  it("rejects non-admin rename", async () => {
    const adminId = uniqueId("zcc-patch-admin");
    await setupAdminOrg(adminId);
    const created = await createSampleConnector();
    const { id } = await created.json();

    mockClerk({
      userId: uniqueId("zcc-patch-member"),
      orgId: `org_mock_${adminId}`,
      orgRole: "org:member",
    });

    const res = await PATCH_BY_ID(
      createTestRequest(url(`/${id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Hacked" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 for unknown id", async () => {
    const userId = uniqueId("zcc-patch-404");
    await setupAdminOrg(userId);
    const fakeId = "00000000-0000-0000-0000-000000000000";

    const res = await PATCH_BY_ID(
      createTestRequest(url(`/${fakeId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Whatever" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when patching a connector from another org", async () => {
    // Create in org A as admin
    const adminA = uniqueId("zcc-patch-crossorg-a");
    await setupAdminOrg(adminA);
    const created = await createSampleConnector();
    const { id } = await created.json();

    // Switch to a different org as admin there
    const adminB = uniqueId("zcc-patch-crossorg-b");
    await setupAdminOrg(adminB);

    const res = await PATCH_BY_ID(
      createTestRequest(url(`/${id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Cross-org" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("rejects empty displayName with 400", async () => {
    const userId = uniqueId("zcc-patch-empty");
    await setupAdminOrg(userId);
    const created = await createSampleConnector();
    const { id } = await created.json();

    const res = await PATCH_BY_ID(
      createTestRequest(url(`/${id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/zero/custom-connectors/:id/secret", () => {
  beforeEach(() => {
    return context.setupMocks();
  });

  it("stores per-user secret and reflects in hasSecret", async () => {
    const userId = uniqueId("zcc-secret");
    await setupAdminOrg(userId);

    const created = await createSampleConnector();
    const { id } = await created.json();

    const res = await PUT_SECRET(
      createTestRequest(url(`/${id}/secret`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "sk_live_xyz" }),
      }),
    );
    expect(res.status).toBe(204);

    const listRes = await GET(createTestRequest(url(), { method: "GET" }));
    const listData = await listRes.json();
    expect(listData.connectors[0].hasSecret).toBe(true);
  });

  it("returns 404 for unknown connector id", async () => {
    const userId = uniqueId("zcc-sec-404");
    await setupAdminOrg(userId);
    const id = "00000000-0000-0000-0000-000000000000";
    const res = await PUT_SECRET(
      createTestRequest(url(`/${id}/secret`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "x" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("allows member (not admin) to set own secret", async () => {
    const adminId = uniqueId("zcc-member-secret-admin");
    await setupAdminOrg(adminId);
    const created = await createSampleConnector();
    const { id } = await created.json();

    // Switch to member in the same org
    mockClerk({
      userId: uniqueId("zcc-member-secret"),
      orgId: `org_mock_${adminId}`,
      orgRole: "org:member",
    });

    const res = await PUT_SECRET(
      createTestRequest(url(`/${id}/secret`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "member-token" }),
      }),
    );
    expect(res.status).toBe(204);
  });
});

describe("DELETE /api/zero/custom-connectors/:id/secret", () => {
  beforeEach(() => {
    return context.setupMocks();
  });

  it("clears the user's secret", async () => {
    const userId = uniqueId("zcc-del-secret");
    await setupAdminOrg(userId);
    const created = await createSampleConnector();
    const { id } = await created.json();

    await PUT_SECRET(
      createTestRequest(url(`/${id}/secret`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "abc" }),
      }),
    );

    const delRes = await DELETE_SECRET(
      createTestRequest(url(`/${id}/secret`), { method: "DELETE" }),
    );
    expect(delRes.status).toBe(204);

    const listRes = await GET(createTestRequest(url(), { method: "GET" }));
    const listData = await listRes.json();
    expect(listData.connectors[0].hasSecret).toBe(false);
  });
});
