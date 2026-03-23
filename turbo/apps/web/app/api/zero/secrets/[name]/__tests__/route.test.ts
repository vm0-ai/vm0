import { describe, it, expect, beforeEach } from "vitest";
import { DELETE } from "../route";
import { POST, GET } from "../../route";
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

/**
 * Setup an org with the given user as admin.
 */
async function setupOrg(userId: string) {
  const slug = uniqueId("zsec-del");
  const orgId = `org_mock_${userId}`;

  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);

  return { slug, orgId };
}

function secretUrl(slug: string): string {
  return `http://localhost:3000/api/zero/secrets?org=${slug}`;
}

function secretByNameUrl(slug: string, name: string): string {
  return `http://localhost:3000/api/zero/secrets/${name}?org=${slug}`;
}

describe("DELETE /api/zero/secrets/:name", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should delete secret successfully", async () => {
    const userId = uniqueId("zsec-del-ok");
    const { slug } = await setupOrg(userId);

    // Create a secret
    await POST(
      createTestRequest(secretUrl(slug), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "DELETE_ME",
          value: "to-be-deleted",
        }),
      }),
    );

    // Verify it exists via GET list
    const listResponse = await GET(
      createTestRequest(secretUrl(slug), { method: "GET" }),
    );
    const listData = await listResponse.json();
    expect(listData.secrets).toHaveLength(1);

    // Delete it
    const deleteResponse = await DELETE(
      createTestRequest(secretByNameUrl(slug, "DELETE_ME"), {
        method: "DELETE",
      }),
    );
    expect(deleteResponse.status).toBe(204);

    // Verify it's gone
    const listResponse2 = await GET(
      createTestRequest(secretUrl(slug), { method: "GET" }),
    );
    const listData2 = await listResponse2.json();
    expect(listData2.secrets).toEqual([]);
  });

  it("should return 404 for nonexistent secret", async () => {
    const userId = uniqueId("zsec-del-404");
    const { slug } = await setupOrg(userId);

    const response = await DELETE(
      createTestRequest(secretByNameUrl(slug, "NONEXISTENT"), {
        method: "DELETE",
      }),
    );
    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should reject unauthenticated requests", async () => {
    mockClerk({ userId: null });

    const response = await DELETE(
      createTestRequest(
        "http://localhost:3000/api/zero/secrets/ANY_KEY?org=test",
        { method: "DELETE" },
      ),
    );
    expect(response.status).toBe(401);
  });
});
