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
import { findTestVariablesByOrgAndName } from "../../../../../../src/__tests__/db-test-assertions/secrets";
import { insertTestUserVariable } from "../../../../../../src/__tests__/db-test-seeders/secrets";

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

  it("should return 401 when authenticated session has no organization", async () => {
    mockClerk({ userId: uniqueId("zvar-del-no-org"), orgId: null });

    const response = await DELETE(
      createTestRequest(variableByNameUrl("ANY_VAR"), {
        method: "DELETE",
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 404 for a variable owned by another user", async () => {
    const userId = uniqueId("zvar-del-cross-user");
    const { orgId } = await setupOrg(userId);

    await insertTestUserVariable({
      orgId,
      userId: uniqueId("zvar-del-victim"),
      name: "OTHER_USER_VAR",
      value: "other-user",
    });

    const response = await DELETE(
      createTestRequest(variableByNameUrl("OTHER_USER_VAR"), {
        method: "DELETE",
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");

    const victim = await findTestVariablesByOrgAndName({
      orgId,
      name: "OTHER_USER_VAR",
    });
    expect(victim).toHaveLength(1);
  });

  it("should return 404 for a variable in another org", async () => {
    const userId = uniqueId("zvar-del-cross-org");
    await setupOrg(userId);
    const victimOrgId = `org_${uniqueId("zvar-del-victim-org")}`;

    await insertTestUserVariable({
      orgId: victimOrgId,
      userId,
      name: "ORG_A_VAR",
      value: "other-org",
    });

    const response = await DELETE(
      createTestRequest(variableByNameUrl("ORG_A_VAR"), {
        method: "DELETE",
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");

    const victim = await findTestVariablesByOrgAndName({
      orgId: victimOrgId,
      name: "ORG_A_VAR",
    });
    expect(victim).toHaveLength(1);
    expect(victim[0]?.orgId).toBe(victimOrgId);
  });
});
