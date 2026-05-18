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
import { findTestSecretsByOrgAndName } from "../../../../../../src/__tests__/db-test-assertions/secrets";
import { insertTestUserSecret } from "../../../../../../src/__tests__/db-test-seeders/secrets";

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

function secretByNameUrl(name: string): string {
  return `http://localhost:3000/api/zero/secrets/${name}`;
}

describe("DELETE /api/zero/secrets/:name", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should delete secret successfully", async () => {
    const userId = uniqueId("zsec-del-ok");
    const { orgId } = await setupOrg(userId);

    await insertTestUserSecret({
      orgId,
      userId,
      name: "DELETE_ME",
      value: "to-be-deleted",
    });

    const beforeDelete = await findTestSecretsByOrgAndName({
      orgId,
      name: "DELETE_ME",
    });
    expect(beforeDelete).toHaveLength(1);

    // Delete it
    const deleteResponse = await DELETE(
      createTestRequest(secretByNameUrl("DELETE_ME"), {
        method: "DELETE",
      }),
    );
    expect(deleteResponse.status).toBe(204);

    const afterDelete = await findTestSecretsByOrgAndName({
      orgId,
      name: "DELETE_ME",
    });
    expect(afterDelete).toEqual([]);
  });

  it("should return 404 for nonexistent secret", async () => {
    const userId = uniqueId("zsec-del-404");
    await setupOrg(userId);

    const response = await DELETE(
      createTestRequest(secretByNameUrl("NONEXISTENT"), {
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
      createTestRequest("http://localhost:3000/api/zero/secrets/ANY_KEY", {
        method: "DELETE",
      }),
    );
    expect(response.status).toBe(401);
  });

  it("should return 401 when authenticated session has no organization", async () => {
    mockClerk({ userId: uniqueId("zsec-del-no-org"), orgId: null });

    const response = await DELETE(
      createTestRequest(secretByNameUrl("ANY_KEY"), {
        method: "DELETE",
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 404 for a secret owned by another user", async () => {
    const userId = uniqueId("zsec-del-cross-user");
    const { orgId } = await setupOrg(userId);

    await insertTestUserSecret({
      orgId,
      userId: uniqueId("zsec-del-victim"),
      name: "OTHER_USER_SECRET",
    });

    const response = await DELETE(
      createTestRequest(secretByNameUrl("OTHER_USER_SECRET"), {
        method: "DELETE",
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");

    const victim = await findTestSecretsByOrgAndName({
      orgId,
      name: "OTHER_USER_SECRET",
    });
    expect(victim).toHaveLength(1);
  });

  it("should return 404 for a secret in another org", async () => {
    const userId = uniqueId("zsec-del-cross-org");
    await setupOrg(userId);
    const victimOrgId = `org_${uniqueId("zsec-del-victim-org")}`;

    await insertTestUserSecret({
      orgId: victimOrgId,
      userId,
      name: "ORG_A_SECRET",
    });

    const response = await DELETE(
      createTestRequest(secretByNameUrl("ORG_A_SECRET"), {
        method: "DELETE",
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");

    const victim = await findTestSecretsByOrgAndName({
      orgId: victimOrgId,
      name: "ORG_A_SECRET",
    });
    expect(victim).toHaveLength(1);
    expect(victim[0]?.orgId).toBe(victimOrgId);
  });

  it("should not delete non-user-type secrets", async () => {
    const userId = uniqueId("zsec-del-type");
    const { orgId } = await setupOrg(userId);

    await insertTestUserSecret({
      orgId,
      userId,
      name: "CONNECTOR_SECRET",
      type: "connector",
    });

    const response = await DELETE(
      createTestRequest(secretByNameUrl("CONNECTOR_SECRET"), {
        method: "DELETE",
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");

    const victim = await findTestSecretsByOrgAndName({
      orgId,
      name: "CONNECTOR_SECRET",
    });
    expect(victim).toHaveLength(1);
    expect(victim[0]?.type).toBe("connector");
  });
});
