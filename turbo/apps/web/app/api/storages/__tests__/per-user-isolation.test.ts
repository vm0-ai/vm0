import { describe, it, expect, beforeEach } from "vitest";
import {
  createTestArtifact,
  createTestVolume,
  findTestStorage,
} from "../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../src/__tests__/test-helpers";
import { VOLUME_ORG_USER_ID } from "@vm0/core/storage-names";

const context = testContext();

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

  it("should store volumes in different orgs with sentinel userId", async () => {
    const userA = await context.user;

    await createTestVolume("shared-data");

    const userB = await context.setupUser({
      prefix: "other-user",
    });
    await createTestVolume("shared-data");

    const recordA = await findTestStorage(userA.orgId, "shared-data", "volume");
    const recordB = await findTestStorage(userB.orgId, "shared-data", "volume");
    expect(recordA!.userId).toBe(VOLUME_ORG_USER_ID);
    expect(recordB!.userId).toBe(VOLUME_ORG_USER_ID);
  });
});
