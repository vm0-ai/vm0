import { describe, it, expect, beforeEach } from "vitest";
// eslint-disable-next-line web/no-direct-db-in-tests -- Internal infrastructure: no API route
import { prepareStorageManifest } from "../storage-service";
import {
  createTestArtifact,
  createTestVolume,
} from "../../../../__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../__tests__/test-helpers";
import type { AdditionalVolume, AgentVolumeConfig } from "../types";
import type { ContextArtifact } from "../../run/types";

const context = testContext();

const WORKING_DIR = "/home/user/workspace";

/**
 * Minimal agent config with no volumes. Required to trigger volume resolution
 * even when only artifacts are being resolved.
 */
function emptyAgentConfig(): AgentVolumeConfig {
  return {
    agents: { "test-agent": {} },
    volumes: {},
  };
}

/** Agent config that only carries volumes (no compose-level artifact entries). */
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

describe("Unified artifact list (ContextArtifact[])", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("resolves a single artifact at its explicit mount path", async () => {
    const artifactName = uniqueId("primary-one");
    const { versionId } = await createTestArtifact(artifactName);

    const artifacts: ContextArtifact[] = [
      { name: artifactName, mountPath: WORKING_DIR },
    ];

    const manifest = await prepareStorageManifest(
      emptyAgentConfig(),
      {},
      user.orgId,
      user.orgId,
      user.userId,
      artifacts,
    );

    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]!.vasStorageName).toBe(artifactName);
    expect(manifest.artifacts[0]!.vasVersionId).toBe(versionId);
    expect(manifest.artifacts[0]!.mountPath).toBe(WORKING_DIR);
    expect(manifest.artifacts[0]!.manifestUrl).toBeDefined();
    expect(manifest.storages).toHaveLength(0);
  });

  it("resolves multiple artifacts with independent mount paths", async () => {
    const nameA = uniqueId("primary-a");
    const nameB = uniqueId("primary-b");
    const { versionId: vA } = await createTestArtifact(nameA);
    const { versionId: vB } = await createTestArtifact(nameB);

    const artifacts: ContextArtifact[] = [
      { name: nameA, mountPath: WORKING_DIR },
      { name: nameB, mountPath: "/mnt/other" },
    ];

    const manifest = await prepareStorageManifest(
      emptyAgentConfig(),
      {},
      user.orgId,
      user.orgId,
      user.userId,
      artifacts,
    );

    expect(manifest.artifacts).toHaveLength(2);
    const byName = Object.fromEntries(
      manifest.artifacts.map((a) => {
        return [a.vasStorageName, a];
      }),
    );
    expect(byName[nameA]!.vasVersionId).toBe(vA);
    expect(byName[nameA]!.mountPath).toBe(WORKING_DIR);
    expect(byName[nameB]!.vasVersionId).toBe(vB);
    expect(byName[nameB]!.mountPath).toBe("/mnt/other");
  });

  it("resolves artifact with an explicit pinned version", async () => {
    const artifactName = uniqueId("primary-pinned");
    const { versionId } = await createTestArtifact(artifactName);

    const artifacts: ContextArtifact[] = [
      { name: artifactName, version: versionId, mountPath: WORKING_DIR },
    ];

    const manifest = await prepareStorageManifest(
      emptyAgentConfig(),
      {},
      user.orgId,
      user.orgId,
      user.userId,
      artifacts,
    );

    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]!.vasVersionId).toBe(versionId);
    expect(manifest.artifacts[0]!.mountPath).toBe(WORKING_DIR);
  });

  it("mixes artifact, compose volume, and per-entry mount path", async () => {
    const artifactA = uniqueId("primary-mix");
    const artifactB = uniqueId("additional-mix");
    const volumeStorageName = uniqueId("vol-mix");
    const volumeKey = uniqueId("vol");

    const { versionId: versionA } = await createTestArtifact(artifactA);
    const { versionId: versionB } = await createTestArtifact(artifactB);
    const { versionId: volumeVersion } =
      await createTestVolume(volumeStorageName);

    const artifacts: ContextArtifact[] = [
      { name: artifactA, mountPath: WORKING_DIR },
      { name: artifactB, mountPath: "/mnt/extra-artifact" },
    ];

    const manifest = await prepareStorageManifest(
      composeVolumeConfig(volumeKey, volumeStorageName, "/data"),
      {},
      user.orgId,
      user.orgId,
      user.userId,
      artifacts,
    );

    expect(manifest.artifacts).toHaveLength(2);
    const artifactByName = Object.fromEntries(
      manifest.artifacts.map((a) => {
        return [a.vasStorageName, a];
      }),
    );
    expect(artifactByName[artifactA]!.vasVersionId).toBe(versionA);
    expect(artifactByName[artifactA]!.mountPath).toBe(WORKING_DIR);
    expect(artifactByName[artifactB]!.vasVersionId).toBe(versionB);
    expect(artifactByName[artifactB]!.mountPath).toBe("/mnt/extra-artifact");

    expect(manifest.storages).toHaveLength(1);
    expect(manifest.storages[0]!.vasStorageName).toBe(volumeStorageName);
    expect(manifest.storages[0]!.vasVersionId).toBe(volumeVersion);
    expect(manifest.storages[0]!.mountPath).toBe("/data");
  });

  it("returns empty artifacts array when list is empty", async () => {
    const manifest = await prepareStorageManifest(
      emptyAgentConfig(),
      {},
      user.orgId,
      user.orgId,
      user.userId,
      [],
    );

    expect(manifest.artifacts).toHaveLength(0);
    expect(manifest.storages).toHaveLength(0);
  });

  it("later entry overrides earlier entry with the same name (dedup by name, last wins)", async () => {
    // Same-name collision is the basis for memory injection: a checkpoint
    // snapshot may already carry a "memory" entry, and Zero appends a fresh
    // one. The later append must win.
    const name = uniqueId("dedup-name");
    const { versionId: firstVersion } = await createTestArtifact(name);

    const artifacts: ContextArtifact[] = [
      { name, version: firstVersion, mountPath: "/old-path" },
      { name, mountPath: "/new-path" },
    ];

    const manifest = await prepareStorageManifest(
      emptyAgentConfig(),
      {},
      user.orgId,
      user.orgId,
      user.userId,
      artifacts,
    );

    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]!.vasStorageName).toBe(name);
    // Last entry had no version → "latest" → resolves to the HEAD version
    expect(manifest.artifacts[0]!.mountPath).toBe("/new-path");
  });

  it("artifacts coexist with additional volumes at different mount paths", async () => {
    const artifactName = uniqueId("primary-with-vol");
    const volumeName = uniqueId("addvol-with-artifact");
    const { versionId: artifactVersion } =
      await createTestArtifact(artifactName);
    const { versionId: volumeVersion } = await createTestVolume(volumeName);

    const additionalVolumes: AdditionalVolume[] = [
      { name: volumeName, mountPath: "/mnt/data" },
    ];

    const artifacts: ContextArtifact[] = [
      { name: artifactName, mountPath: WORKING_DIR },
    ];

    const manifest = await prepareStorageManifest(
      emptyAgentConfig(),
      {},
      user.orgId,
      user.orgId,
      user.userId,
      artifacts,
      undefined,
      additionalVolumes,
    );

    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]!.vasStorageName).toBe(artifactName);
    expect(manifest.artifacts[0]!.vasVersionId).toBe(artifactVersion);
    expect(manifest.artifacts[0]!.mountPath).toBe(WORKING_DIR);

    expect(manifest.storages).toHaveLength(1);
    expect(manifest.storages[0]!.vasStorageName).toBe(volumeName);
    expect(manifest.storages[0]!.vasVersionId).toBe(volumeVersion);
    expect(manifest.storages[0]!.mountPath).toBe("/mnt/data");
  });
});
