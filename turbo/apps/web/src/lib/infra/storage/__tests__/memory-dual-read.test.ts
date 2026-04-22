import { describe, it, expect, beforeEach } from "vitest";
// eslint-disable-next-line web/no-direct-db-in-tests -- Internal infrastructure: no API route
import { prepareStorageManifest } from "../storage-service";
import { AUTO_MEMORY_MOUNT_PATH } from "../types";
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

// Memory now rides in manifest.artifacts[] (see #10602). Dual-read fallback
// (type='artifact' preferred, type='memory' fallback) moved to the
// resolveAdditionalArtifact path in storage-service.
describe("Memory dual-read via additionalArtifacts", () => {
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
      undefined,
      [{ name: memoryName, mountPath: AUTO_MEMORY_MOUNT_PATH }],
    );

    expect(manifest.memory).toBeNull();
    const entry = manifest.artifacts.find((a) => {
      return a.vasStorageName === memoryName;
    });
    expect(entry).toBeDefined();
    expect(entry!.vasVersionId).toBe(versionId);
    expect(entry!.mountPath).toBe(AUTO_MEMORY_MOUNT_PATH);
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
      undefined,
      [{ name: memoryName, mountPath: AUTO_MEMORY_MOUNT_PATH }],
    );

    expect(manifest.memory).toBeNull();
    const entry = manifest.artifacts.find((a) => {
      return a.vasStorageName === memoryName;
    });
    expect(entry).toBeDefined();
    expect(entry!.vasVersionId).toBe(versionId);
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
      undefined,
      [{ name: memoryName, mountPath: AUTO_MEMORY_MOUNT_PATH }],
    );

    expect(manifest.memory).toBeNull();
    const entry = manifest.artifacts.find((a) => {
      return a.vasStorageName === memoryName;
    });
    expect(entry).toBeDefined();
    expect(entry!.vasVersionId).toBe(artifactVersionId);
    expect(entry!.vasVersionId).not.toBe(memoryVersionId);
  });
});
