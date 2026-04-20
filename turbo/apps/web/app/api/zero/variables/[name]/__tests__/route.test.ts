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
  const slug = uniqueId("zvar-del");
  const orgId = `org_mock_${userId}`;

  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);

  return { slug, orgId };
}

function variableUrl(): string {
  return `http://localhost:3000/api/zero/variables`;
}

function variableByNameUrl(name: string): string {
  return `http://localhost:3000/api/zero/variables/${name}`;
}

describe("DELETE /api/zero/variables/:name", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should delete variable successfully", async () => {
    const userId = uniqueId("zvar-del-ok");
    await setupOrg(userId);

    // Create a variable
    await POST(
      createTestRequest(variableUrl(), {
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
      createTestRequest(variableUrl(), { method: "GET" }),
    );
    const listData = await listResponse.json();
    expect(listData.variables).toHaveLength(1);

    // Delete it
    const deleteResponse = await DELETE(
      createTestRequest(variableByNameUrl("DELETE_ME"), {
        method: "DELETE",
      }),
    );
    expect(deleteResponse.status).toBe(204);

    // Verify it's gone
    const listResponse2 = await GET(
      createTestRequest(variableUrl(), { method: "GET" }),
    );
    const listData2 = await listResponse2.json();
    expect(listData2.variables).toEqual([]);
  });

  it("should return 404 for nonexistent variable", async () => {
    const userId = uniqueId("zvar-del-404");
    await setupOrg(userId);

    const response = await DELETE(
      createTestRequest(variableByNameUrl("NONEXISTENT"), {
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
      createTestRequest("http://localhost:3000/api/zero/variables/ANY_VAR", {
        method: "DELETE",
      }),
    );
    expect(response.status).toBe(401);
  });
});
