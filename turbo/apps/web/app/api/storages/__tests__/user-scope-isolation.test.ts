import { describe, it, expect, beforeEach } from "vitest";
import { GET as listRoute } from "../list/route";
import {
  createTestRequest,
  createTestArtifact,
  createTestVolume,
  findTestStorage,
} from "../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { VOLUME_SCOPE_USER_ID } from "@vm0/core";

const context = testContext();

function listStorages(type: string) {
  return listRoute(
    createTestRequest(`http://localhost:3000/api/storages/list?type=${type}`),
  );
}

describe("Storage user-scope isolation", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("should store volumes with sentinel userId in database", async () => {
    const user = await context.user;

    await createTestVolume("shared-vol");

    const record = await findTestStorage(user.scopeId, "shared-vol", "volume");
    expect(record).toBeDefined();
    expect(record!.userId).toBe(VOLUME_SCOPE_USER_ID);
  });

  it("should store artifacts with real userId in database", async () => {
    const user = await context.user;

    await createTestArtifact("my-artifact");

    const record = await findTestStorage(
      user.scopeId,
      "my-artifact",
      "artifact",
    );
    expect(record).toBeDefined();
    expect(record!.userId).toBe(user.userId);
  });

  it("should isolate artifacts per user - different users cannot see each other's artifacts", async () => {
    // User A creates an artifact
    await createTestArtifact("shared-name");

    const userAResponse = await listStorages("artifact");
    const userAArtifacts = await userAResponse.json();
    expect(userAArtifacts).toHaveLength(1);
    expect(userAArtifacts[0].name).toBe("shared-name");

    // User B (different scope) should not see User A's artifact
    const userB = await context.setupUser({ prefix: "other-user" });
    mockClerk({ userId: userB.userId });

    const userBResponse = await listStorages("artifact");
    const userBArtifacts = await userBResponse.json();
    expect(userBArtifacts).toHaveLength(0);
  });

  it("should allow same artifact name for different users", async () => {
    const userA = await context.user;

    // User A creates artifact "results"
    await createTestArtifact("results");

    // Switch to User B
    const userB = await context.setupUser({ prefix: "other-user" });
    mockClerk({ userId: userB.userId });

    // User B creates artifact with same name "results"
    await createTestArtifact("results");

    // User B should only see their own
    const userBResponse = await listStorages("artifact");
    const userBArtifacts = await userBResponse.json();
    expect(userBArtifacts).toHaveLength(1);

    // Switch back to User A
    mockClerk({ userId: userA.userId });

    // User A should only see their own
    const userAResponse = await listStorages("artifact");
    const userAArtifacts = await userAResponse.json();
    expect(userAArtifacts).toHaveLength(1);
  });
});
