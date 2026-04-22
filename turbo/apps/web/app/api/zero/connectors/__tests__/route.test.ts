import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestOrg,
  insertTestPlatformConnector,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zcon");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function connectorsUrl(): string {
  return `http://localhost:3000/api/zero/connectors`;
}

describe("GET /api/zero/connectors", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return empty connectors list", async () => {
    const userId = uniqueId("zcon-list");
    await setupOrg(userId);

    const response = await GET(createTestRequest(connectorsUrl()));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.connectors).toEqual([]);
    expect(Array.isArray(data.configuredTypes)).toBe(true);
    expect(Array.isArray(data.connectorProvidedSecretNames)).toBe(true);
  });

  it("should return connectors when present", async () => {
    const userId = uniqueId("zcon-has");
    const { orgId } = await setupOrg(userId);
    await context.createConnector(orgId, { userId, type: "github" });

    const response = await GET(createTestRequest(connectorsUrl()));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.connectors.length).toBeGreaterThanOrEqual(1);
    expect(
      data.connectors.some((c: { type: string }) => {
        return c.type === "github";
      }),
    ).toBe(true);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest("http://localhost:3000/api/zero/connectors"),
    );
    expect(response.status).toBe(401);
  });

  it("skips platform rows whose type no longer exists in the contract", async () => {
    // Regression: when a platform-managed connector is removed from
    // CONNECTOR_TYPES, any previously-enabled row in user_platform_connectors
    // becomes orphaned. The list endpoint must stay usable — silently drop
    // the orphan instead of failing the whole response.
    const userId = uniqueId("zcon-orphan");
    const { orgId } = await setupOrg(userId);
    await insertTestPlatformConnector(orgId, userId, "__removed_connector__");

    const response = await GET(createTestRequest(connectorsUrl()));
    expect(response.status).toBe(200);
    const data = await response.json();
    const orphan = data.connectors.find((c: { type: string }) => {
      return c.type === "__removed_connector__";
    });
    expect(orphan).toBeUndefined();
  });
});
