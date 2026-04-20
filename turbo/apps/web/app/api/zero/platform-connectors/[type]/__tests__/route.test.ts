import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import { GET } from "../../../connectors/[type]/route";
import {
  createTestRequest,
  createTestOrg,
  countPlatformConnectorRows,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zpl");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function enableUrl(type: string): string {
  return `http://localhost:3000/api/zero/platform-connectors/${type}`;
}

function connectorUrl(type: string): string {
  return `http://localhost:3000/api/zero/connectors/${type}`;
}

describe("POST /api/zero/platform-connectors/:type", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("creates a platform row and reports authMethod='platform'", async () => {
    const userId = uniqueId("zpl-ok");
    const { orgId } = await setupOrg(userId);

    const response = await POST(
      createTestRequest(enableUrl("nano-banana"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.type).toBe("nano-banana");
    expect(data.authMethod).toBe("platform");
    expect(data.oauthScopes).toBeNull();
    expect(data.externalId).toBeNull();
    expect(await countPlatformConnectorRows(orgId, userId, "nano-banana")).toBe(
      1,
    );
  });

  it("is idempotent: POST twice leaves exactly one row", async () => {
    const userId = uniqueId("zpl-idem");
    const { orgId } = await setupOrg(userId);

    for (let i = 0; i < 2; i++) {
      const response = await POST(
        createTestRequest(enableUrl("nano-banana"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      expect(response.status).toBe(200);
    }

    // Pin the "double enable must not double-insert" invariant at the row
    // level — a drifted conflict target would pass a status-only assert.
    expect(await countPlatformConnectorRows(orgId, userId, "nano-banana")).toBe(
      1,
    );
  });

  it("round-trips: enabled row is readable via GET /api/zero/connectors/:type", async () => {
    const userId = uniqueId("zpl-rt");
    await setupOrg(userId);

    const created = await POST(
      createTestRequest(enableUrl("nano-banana"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(created.status).toBe(200);
    const createdBody = await created.json();

    const fetched = await GET(createTestRequest(connectorUrl("nano-banana")));
    expect(fetched.status).toBe(200);
    const fetchedBody = await fetched.json();
    expect(fetchedBody.id).toBe(createdBody.id);
    expect(fetchedBody.type).toBe("nano-banana");
    expect(fetchedBody.authMethod).toBe("platform");
  });

  it("rejects types that don't declare a platform auth method", async () => {
    const userId = uniqueId("zpl-np");
    await setupOrg(userId);

    const response = await POST(
      createTestRequest(enableUrl("github"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await POST(
      createTestRequest(enableUrl("nano-banana"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(401);
  });
});
