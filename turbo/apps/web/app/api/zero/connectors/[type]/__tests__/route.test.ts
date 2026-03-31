import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { GET, DELETE } from "../route";
import {
  createTestRequest,
  createTestOrg,
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

function connectorUrl(slug: string, type: string): string {
  return `http://localhost:3000/api/zero/connectors/${type}?org=${slug}`;
}

describe("GET /api/zero/connectors/:type", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return connector when present", async () => {
    const userId = uniqueId("zcget-ok");
    const { slug, orgId } = await setupOrg(userId);
    await context.createConnector(orgId, { userId, type: "github" });

    const response = await GET(createTestRequest(connectorUrl(slug, "github")));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.type).toBe("github");
  });

  it("should return 404 when connector not found", async () => {
    const userId = uniqueId("zcget-nf");
    const { slug } = await setupOrg(userId);

    const response = await GET(createTestRequest(connectorUrl(slug, "github")));
    expect(response.status).toBe(404);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest(connectorUrl("test", "github")),
    );
    expect(response.status).toBe(401);
  });

  it("should allow access with ZERO_TOKEN (agent:read capability)", async () => {
    const user = await context.setupUser();

    await context.createConnector(user.orgId, {
      userId: user.userId,
      type: "github",
    });

    const orgSlug = `org-${user.userId.slice(-8)}`;
    const zeroToken = await generateZeroToken(
      user.userId,
      randomUUID(),
      user.orgId,
    );

    const response = await GET(
      new NextRequest(connectorUrl(orgSlug, "github"), {
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
    const { slug, orgId } = await setupOrg(userId);
    await context.createConnector(orgId, { userId, type: "github" });

    const response = await DELETE(
      createTestRequest(connectorUrl(slug, "github"), { method: "DELETE" }),
    );
    expect(response.status).toBe(204);
  });

  it("should return 404 when connector not found", async () => {
    const userId = uniqueId("zcdel-nf");
    const { slug } = await setupOrg(userId);

    const response = await DELETE(
      createTestRequest(connectorUrl(slug, "github"), { method: "DELETE" }),
    );
    expect(response.status).toBe(404);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await DELETE(
      createTestRequest(connectorUrl("test", "github"), { method: "DELETE" }),
    );
    expect(response.status).toBe(401);
  });
});
