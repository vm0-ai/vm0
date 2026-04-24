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
import { VOLUME_ORG_USER_ID } from "@vm0/core/storage-names";

const context = testContext();

function listStorages(type: string) {
  return listRoute(
    createTestRequest(`http://localhost:3000/api/storages/list?type=${type}`),
  );
}

describe("Storage per-user isolation", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("should store volumes with sentinel userId in database", async () => {
    const user = await context.user;

    await createTestVolume("shared-vol");

    const record = await findTestStorage(user.orgId, "shared-vol", "volume");
    expect(record).toBeDefined();
    expect(record!.userId).toBe(VOLUME_ORG_USER_ID);
  });

  it("should store artifacts with real userId in database", async () => {
    const user = await context.user;

    await createTestArtifact("my-artifact");

    const record = await findTestStorage(user.orgId, "my-artifact", "artifact");
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

    // User B (different org) should not see User A's artifact
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

  it("should share volumes across users via sentinel userId", async () => {
    const userA = await context.user;

    // User A creates a volume
    await createTestVolume("shared-data");

    const userAResponse = await listStorages("volume");
    const userAVolumes = await userAResponse.json();
    expect(userAVolumes).toHaveLength(1);
    expect(userAVolumes[0].name).toBe("shared-data");

    // User B (different org) creates volume with same name in their org
    const userB = await context.setupUser({ prefix: "other-user" });
    mockClerk({ userId: userB.userId });

    await createTestVolume("shared-data");

    // User B should see their org's volume
    const userBResponse = await listStorages("volume");
    const userBVolumes = await userBResponse.json();
    expect(userBVolumes).toHaveLength(1);
    expect(userBVolumes[0].name).toBe("shared-data");

    // Both volumes use sentinel userId, not the real user
    const recordA = await findTestStorage(userA.orgId, "shared-data", "volume");
    const recordB = await findTestStorage(userB.orgId, "shared-data", "volume");
    expect(recordA!.userId).toBe(VOLUME_ORG_USER_ID);
    expect(recordB!.userId).toBe(VOLUME_ORG_USER_ID);
  });
});
