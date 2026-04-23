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
import type {
  AdditionalArtifact,
  AdditionalVolume,
  AgentVolumeConfig,
} from "../types";

const context = testContext();

const WORKING_DIR = "/home/user/workspace";

/**
 * Minimal agent config with no volumes — primary artifacts flow through
 * resolveVolumes via the `artifacts` map regardless of compose volume decls,
 * but an agentConfig object is required to trigger resolution at all.
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

describe("Primary Artifacts (artifacts record map)", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("resolves a single primary artifact at compose working_dir", async () => {
    const artifactName = uniqueId("primary-one");
    const { versionId } = await createTestArtifact(artifactName);

    const manifest = await prepareStorageManifest(
      emptyAgentConfig(),
      {},
      user.orgId,
      user.orgId,
      user.userId,
      { [artifactName]: "latest" },
      WORKING_DIR,
    );

    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]!.vasStorageName).toBe(artifactName);
    expect(manifest.artifacts[0]!.vasVersionId).toBe(versionId);
    expect(manifest.artifacts[0]!.mountPath).toBe(WORKING_DIR);
    expect(manifest.artifacts[0]!.manifestUrl).toBeDefined();
    expect(manifest.storages).toHaveLength(0);
  });

  it("resolves multiple primary artifacts at the same working_dir mount", async () => {
    const nameA = uniqueId("primary-a");
    const nameB = uniqueId("primary-b");
    const { versionId: vA } = await createTestArtifact(nameA);
    const { versionId: vB } = await createTestArtifact(nameB);

    const manifest = await prepareStorageManifest(
      emptyAgentConfig(),
      {},
      user.orgId,
      user.orgId,
      user.userId,
      { [nameA]: "latest", [nameB]: "latest" },
      WORKING_DIR,
    );

    expect(manifest.artifacts).toHaveLength(2);
    const byName = Object.fromEntries(
      manifest.artifacts.map((a) => {
        return [a.vasStorageName, a];
      }),
    );
    expect(byName[nameA]!.vasVersionId).toBe(vA);
    expect(byName[nameB]!.vasVersionId).toBe(vB);
    expect(byName[nameA]!.mountPath).toBe(WORKING_DIR);
    expect(byName[nameB]!.mountPath).toBe(WORKING_DIR);
  });

  it("resolves primary artifact with an explicit version (not latest)", async () => {
    const artifactName = uniqueId("primary-pinned");
    const { versionId } = await createTestArtifact(artifactName);

    const manifest = await prepareStorageManifest(
      emptyAgentConfig(),
      {},
      user.orgId,
      user.orgId,
      user.userId,
      { [artifactName]: versionId },
      WORKING_DIR,
    );

    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]!.vasVersionId).toBe(versionId);
    expect(manifest.artifacts[0]!.mountPath).toBe(WORKING_DIR);
  });

  it("mixes primary artifact, compose volume, and additional artifact", async () => {
    const artifactName = uniqueId("primary-mix");
    const additionalArtifactName = uniqueId("additional-mix");
    const volumeStorageName = uniqueId("vol-mix");
    const volumeKey = uniqueId("vol");

    const { versionId: primaryVersion } =
      await createTestArtifact(artifactName);
    const { versionId: additionalVersion } = await createTestArtifact(
      additionalArtifactName,
    );
    const { versionId: volumeVersion } =
      await createTestVolume(volumeStorageName);

    const additionalArtifacts: AdditionalArtifact[] = [
      {
        name: additionalArtifactName,
        mountPath: "/mnt/extra-artifact",
      },
    ];

    const manifest = await prepareStorageManifest(
      composeVolumeConfig(volumeKey, volumeStorageName, "/data"),
      {},
      user.orgId,
      user.orgId,
      user.userId,
      { [artifactName]: "latest" },
      WORKING_DIR,
      undefined,
      undefined,
      additionalArtifacts,
    );

    // Primary artifact at working_dir + additional artifact at its explicit path
    expect(manifest.artifacts).toHaveLength(2);
    const artifactByName = Object.fromEntries(
      manifest.artifacts.map((a) => {
        return [a.vasStorageName, a];
      }),
    );
    expect(artifactByName[artifactName]!.vasVersionId).toBe(primaryVersion);
    expect(artifactByName[artifactName]!.mountPath).toBe(WORKING_DIR);
    expect(artifactByName[additionalArtifactName]!.vasVersionId).toBe(
      additionalVersion,
    );
    expect(artifactByName[additionalArtifactName]!.mountPath).toBe(
      "/mnt/extra-artifact",
    );

    // Compose volume resolved alongside
    expect(manifest.storages).toHaveLength(1);
    expect(manifest.storages[0]!.vasStorageName).toBe(volumeStorageName);
    expect(manifest.storages[0]!.vasVersionId).toBe(volumeVersion);
    expect(manifest.storages[0]!.mountPath).toBe("/data");
  });

  it("returns empty artifacts array when artifacts map is empty", async () => {
    const manifest = await prepareStorageManifest(
      emptyAgentConfig(),
      {},
      user.orgId,
      user.orgId,
      user.userId,
      {},
      WORKING_DIR,
    );

    expect(manifest.artifacts).toHaveLength(0);
    expect(manifest.storages).toHaveLength(0);
  });

  it("additional artifact overrides primary artifact at same mount path", async () => {
    const primaryName = uniqueId("primary-override");
    const overrideName = uniqueId("override-at-workingdir");
    const { versionId: primaryVersion } = await createTestArtifact(primaryName);
    const { versionId: overrideVersion } =
      await createTestArtifact(overrideName);

    const additionalArtifacts: AdditionalArtifact[] = [
      { name: overrideName, mountPath: WORKING_DIR },
    ];

    const manifest = await prepareStorageManifest(
      emptyAgentConfig(),
      {},
      user.orgId,
      user.orgId,
      user.userId,
      { [primaryName]: "latest" },
      WORKING_DIR,
      undefined,
      undefined,
      additionalArtifacts,
    );

    // Primary artifact at WORKING_DIR is filtered out; override remains.
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]!.vasStorageName).toBe(overrideName);
    expect(manifest.artifacts[0]!.vasVersionId).toBe(overrideVersion);
    expect(manifest.artifacts[0]!.mountPath).toBe(WORKING_DIR);
    // Primary is gone — its version is not in the output.
    expect(manifest.artifacts[0]!.vasVersionId).not.toBe(primaryVersion);
  });

  it("primary artifacts coexist with additional volumes at different paths", async () => {
    const artifactName = uniqueId("primary-with-vol");
    const volumeName = uniqueId("addvol-with-artifact");
    const { versionId: artifactVersion } =
      await createTestArtifact(artifactName);
    const { versionId: volumeVersion } = await createTestVolume(volumeName);

    const additionalVolumes: AdditionalVolume[] = [
      { name: volumeName, mountPath: "/mnt/data" },
    ];

    const manifest = await prepareStorageManifest(
      emptyAgentConfig(),
      {},
      user.orgId,
      user.orgId,
      user.userId,
      { [artifactName]: "latest" },
      WORKING_DIR,
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
