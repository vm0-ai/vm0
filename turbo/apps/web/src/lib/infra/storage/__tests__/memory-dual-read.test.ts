import { describe, it, expect, beforeEach } from "vitest";
// eslint-disable-next-line web/no-direct-db-in-tests -- Internal infrastructure: no API route
import { prepareStorageManifest } from "../storage-service";
import {
  createTestArtifact,
  createTestMemory,
} from "../../../../__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../__tests__/test-helpers";

const context = testContext();

describe("Memory dual-read (artifact → memory fallback)", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("resolves memory from type='memory' row (pre-flip state)", async () => {
    const memoryName = uniqueId("mem");
    const { versionId } = await createTestMemory(memoryName);

    const manifest = await prepareStorageManifest(
      undefined,
      {},
      user.orgId,
      user.orgId,
      user.userId,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      memoryName,
    );

    expect(manifest.memory).not.toBeNull();
    expect(manifest.memory!.vasStorageName).toBe(memoryName);
    expect(manifest.memory!.vasVersionId).toBe(versionId);
  });

  it("resolves memory from type='artifact' row (post-flip state)", async () => {
    const memoryName = uniqueId("mem");
    const { versionId } = await createTestArtifact(memoryName);

    const manifest = await prepareStorageManifest(
      undefined,
      {},
      user.orgId,
      user.orgId,
      user.userId,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      memoryName,
    );

    expect(manifest.memory).not.toBeNull();
    expect(manifest.memory!.vasStorageName).toBe(memoryName);
    expect(manifest.memory!.vasVersionId).toBe(versionId);
  });

  it("prefers type='artifact' when both rows exist for same name", async () => {
    const memoryName = uniqueId("mem");
    const { versionId: memoryVersionId } = await createTestMemory(memoryName, {
      files: [
        {
          path: "memory.txt",
          hash: "a".repeat(64),
          size: 10,
        },
      ],
    });
    const { versionId: artifactVersionId } = await createTestArtifact(
      memoryName,
      {
        files: [
          {
            path: "artifact.txt",
            hash: "b".repeat(64),
            size: 20,
          },
        ],
      },
    );
    expect(artifactVersionId).not.toBe(memoryVersionId);

    const manifest = await prepareStorageManifest(
      undefined,
      {},
      user.orgId,
      user.orgId,
      user.userId,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      memoryName,
    );

    expect(manifest.memory).not.toBeNull();
    expect(manifest.memory!.vasVersionId).toBe(artifactVersionId);
    expect(manifest.memory!.vasVersionId).not.toBe(memoryVersionId);
  });
});
