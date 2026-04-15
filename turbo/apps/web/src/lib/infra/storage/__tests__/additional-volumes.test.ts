import { describe, it, expect, beforeEach } from "vitest";
// eslint-disable-next-line web/no-direct-db-in-tests -- Internal infrastructure: no API route
import { prepareStorageManifest } from "../storage-service";
import { createTestVolume } from "../../../../__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../__tests__/test-helpers";
import type { AdditionalVolume, AgentVolumeConfig } from "../types";

const context = testContext();

/** Agent config that produces a single regular volume at the given mount path */
function composeVolumeConfig(
  volumeName: string,
  storageName: string,
  mountPath: string,
): AgentVolumeConfig {
  return {
    agents: {
      "test-agent": {
        volumes: [`${volumeName}:${mountPath}`],
      },
    },
    volumes: {
      [volumeName]: {
        name: storageName,
        version: "latest",
      },
    },
  };
}

describe("Additional Volumes", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("should include additional volume when no compose volumes exist", async () => {
    const storageName = uniqueId("addvol");
    const { versionId } = await createTestVolume(storageName);

    const additional: AdditionalVolume[] = [
      { name: storageName, mountPath: "/mnt/extra" },
    ];

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
      additional,
    );

    expect(manifest.storages).toHaveLength(1);
    expect(manifest.storages[0]!.vasStorageName).toBe(storageName);
    expect(manifest.storages[0]!.vasVersionId).toBe(versionId);
    expect(manifest.storages[0]!.mountPath).toBe("/mnt/extra");
  });

  it("should override compose volume at same mount path", async () => {
    const composeStorageName = uniqueId("compose-vol");
    const additionalStorageName = uniqueId("additional-vol");
    const volumeKey = uniqueId("vol");

    await createTestVolume(composeStorageName);
    const { versionId: additionalVersionId } = await createTestVolume(
      additionalStorageName,
    );

    const additional: AdditionalVolume[] = [
      { name: additionalStorageName, mountPath: "/data" },
    ];

    const manifest = await prepareStorageManifest(
      composeVolumeConfig(volumeKey, composeStorageName, "/data"),
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
      additional,
    );

    expect(manifest.storages).toHaveLength(1);
    expect(manifest.storages[0]!.vasStorageName).toBe(additionalStorageName);
    expect(manifest.storages[0]!.vasVersionId).toBe(additionalVersionId);
    expect(manifest.storages[0]!.mountPath).toBe("/data");
  });

  it("should silently skip non-existent additional volume", async () => {
    const additional: AdditionalVolume[] = [
      { name: "nonexistent-volume", mountPath: "/mnt/missing" },
    ];

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
      additional,
    );

    expect(manifest.storages).toHaveLength(0);
  });

  it("should default to latest version when not specified", async () => {
    const storageName = uniqueId("addvol-latest");
    const { versionId } = await createTestVolume(storageName);

    const additional: AdditionalVolume[] = [
      { name: storageName, mountPath: "/mnt/latest" },
    ];

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
      additional,
    );

    expect(manifest.storages).toHaveLength(1);
    expect(manifest.storages[0]!.vasVersionId).toBe(versionId);
  });

  it("should resolve specific version for additional volume", async () => {
    const storageName = uniqueId("addvol-version");
    const { versionId } = await createTestVolume(storageName);

    const additional: AdditionalVolume[] = [
      { name: storageName, version: versionId, mountPath: "/mnt/versioned" },
    ];

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
      additional,
    );

    expect(manifest.storages).toHaveLength(1);
    expect(manifest.storages[0]!.vasVersionId).toBe(versionId);
    expect(manifest.storages[0]!.mountPath).toBe("/mnt/versioned");
  });

  it("should include all additional volumes in manifest", async () => {
    const storageName1 = uniqueId("multi-vol-1");
    const storageName2 = uniqueId("multi-vol-2");
    await createTestVolume(storageName1);
    await createTestVolume(storageName2);

    const additional: AdditionalVolume[] = [
      { name: storageName1, mountPath: "/mnt/one" },
      { name: storageName2, mountPath: "/mnt/two" },
    ];

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
      additional,
    );

    expect(manifest.storages).toHaveLength(2);
    const names = manifest.storages.map((s) => {
      return s.vasStorageName;
    });
    expect(names).toContain(storageName1);
    expect(names).toContain(storageName2);
  });

  it("should resolve additional volumes from runtime org not agent org", async () => {
    const storageName = uniqueId("runtime-vol");
    // Create volume under user's org (acts as runtime org)
    const { versionId } = await createTestVolume(storageName);

    // Use a different agent org (non-existent) — should still work
    // because additional volumes use runtimeClerkOrgId
    const fakeAgentOrgId = "org_fake_agent_org_id";

    const additional: AdditionalVolume[] = [
      { name: storageName, mountPath: "/mnt/runtime" },
    ];

    const manifest = await prepareStorageManifest(
      undefined,
      {},
      fakeAgentOrgId,
      user.orgId,
      user.userId,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      additional,
    );

    expect(manifest.storages).toHaveLength(1);
    expect(manifest.storages[0]!.vasStorageName).toBe(storageName);
    expect(manifest.storages[0]!.vasVersionId).toBe(versionId);
  });

  it("should keep compose volumes at different mount paths", async () => {
    const composeStorageName = uniqueId("compose-keep");
    const additionalStorageName = uniqueId("additional-keep");
    const volumeKey = uniqueId("vol");

    await createTestVolume(composeStorageName);
    await createTestVolume(additionalStorageName);

    const additional: AdditionalVolume[] = [
      { name: additionalStorageName, mountPath: "/mnt/extra" },
    ];

    const manifest = await prepareStorageManifest(
      composeVolumeConfig(volumeKey, composeStorageName, "/data"),
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
      additional,
    );

    expect(manifest.storages).toHaveLength(2);
    const mountPaths = manifest.storages.map((s) => {
      return s.mountPath;
    });
    expect(mountPaths).toContain("/data");
    expect(mountPaths).toContain("/mnt/extra");
  });
});
