import { describe, it, expect, beforeEach } from "vitest";
import { DELETE } from "../route";
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
  const slug = uniqueId("zcdel");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function deleteUrl(slug: string, type: string): string {
  return `http://localhost:3000/api/zero/connectors/${type}?org=${slug}`;
}

describe("DELETE /api/zero/connectors/:type", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should delete a connector and return 204", async () => {
    const userId = uniqueId("zcdel-ok");
    const { slug, orgId } = await setupOrg(userId);
    await context.createConnector(orgId, { userId, type: "github" });

    const response = await DELETE(
      createTestRequest(deleteUrl(slug, "github"), { method: "DELETE" }),
    );
    expect(response.status).toBe(204);
  });

  it("should return 404 when connector not found", async () => {
    const userId = uniqueId("zcdel-nf");
    const { slug } = await setupOrg(userId);

    const response = await DELETE(
      createTestRequest(deleteUrl(slug, "github"), { method: "DELETE" }),
    );
    expect(response.status).toBe(404);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await DELETE(
      createTestRequest(deleteUrl("test", "github"), { method: "DELETE" }),
    );
    expect(response.status).toBe(401);
  });
});
