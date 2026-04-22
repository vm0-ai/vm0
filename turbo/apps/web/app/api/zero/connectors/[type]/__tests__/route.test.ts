import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { GET, DELETE } from "../route";
import {
  createTestRequest,
  createTestOrg,
  insertTestPlatformConnector,
  countPlatformConnectorRows,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { generateZeroToken } from "../../../../../../src/lib/auth/sandbox-token";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zcdel");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function connectorUrl(type: string): string {
  return `http://localhost:3000/api/zero/connectors/${type}`;
}

describe("GET /api/zero/connectors/:type", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return connector when present", async () => {
    const userId = uniqueId("zcget-ok");
    const { orgId } = await setupOrg(userId);
    await context.createConnector(orgId, { userId, type: "github" });

    const response = await GET(createTestRequest(connectorUrl("github")));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.type).toBe("github");
  });

  it("should return 404 when connector not found", async () => {
    const userId = uniqueId("zcget-nf");
    await setupOrg(userId);

    const response = await GET(createTestRequest(connectorUrl("github")));
    expect(response.status).toBe(404);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(createTestRequest(connectorUrl("github")));
    expect(response.status).toBe(401);
  });

  it("should allow access with ZERO_TOKEN (connector:read capability)", async () => {
    const user = await context.setupUser();

    await context.createConnector(user.orgId, {
      userId: user.userId,
      type: "github",
    });

    const zeroToken = await generateZeroToken(
      user.userId,
      randomUUID(),
      user.orgId,
    );

    const response = await GET(
      new NextRequest(connectorUrl("github"), {
        headers: { Authorization: `Bearer ${zeroToken}` },
      }),
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.type).toBe("github");
  });
});

describe("DELETE /api/zero/connectors/:type", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should delete a connector and return 204", async () => {
    const userId = uniqueId("zcdel-ok");
    const { orgId } = await setupOrg(userId);
    await context.createConnector(orgId, { userId, type: "github" });

    const response = await DELETE(
      createTestRequest(connectorUrl("github"), { method: "DELETE" }),
    );
    expect(response.status).toBe(204);
  });

  it("should return 404 when connector not found", async () => {
    const userId = uniqueId("zcdel-nf");
    await setupOrg(userId);

    const response = await DELETE(
      createTestRequest(connectorUrl("github"), { method: "DELETE" }),
    );
    expect(response.status).toBe(404);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await DELETE(
      createTestRequest(connectorUrl("github"), { method: "DELETE" }),
    );
    expect(response.status).toBe(401);
  });

  it("clears both tables when OAuth and platform rows coexist on the same type", async () => {
    // Data-model-wise unlikely (UI enforces single authMethod per type), but
    // cheap to pin: DELETE must not leave the platform row behind after the
    // OAuth branch fires. Use `github` as the carrier type — the platform
    // table only stores varchar, so co-existence is representable at the DB
    // level even though CONNECTOR_TYPES[github] has no platform authMethod.
    const userId = uniqueId("zcdel-dual");
    const { orgId } = await setupOrg(userId);
    await context.createConnector(orgId, { userId, type: "github" });
    await insertTestPlatformConnector(orgId, userId, "github");
    expect(await countPlatformConnectorRows(orgId, userId, "github")).toBe(1);

    const response = await DELETE(
      createTestRequest(connectorUrl("github"), { method: "DELETE" }),
    );
    expect(response.status).toBe(204);

    expect(await countPlatformConnectorRows(orgId, userId, "github")).toBe(0);
    const after = await GET(createTestRequest(connectorUrl("github")));
    expect(after.status).toBe(404);
  });
});
