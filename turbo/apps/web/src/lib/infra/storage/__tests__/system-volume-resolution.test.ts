import { describe, it, expect, beforeEach } from "vitest";
// eslint-disable-next-line web/no-direct-db-in-tests -- Internal infrastructure: no API route
import { prepareStorageManifest } from "../storage-service";
import {
  createTestVolume,
  createTestVolumeForOrg,
} from "../../../../__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../__tests__/test-helpers";
import { SYSTEM_ORG_ID } from "@vm0/core/storage-names";
import type { AgentVolumeConfig } from "../types";

const context = testContext();

function systemVolumeConfig(
  volumeName: string,
  storageName: string,
  opts: { system: boolean; optional?: boolean },
): AgentVolumeConfig {
  return {
    agents: {
      "test-agent": {
        volumes: [`${volumeName}:/data`],
      },
    },
    volumes: {
      [volumeName]: {
        name: storageName,
        version: "latest",
        system: opts.system,
        optional: opts.optional,
      },
    },
  };
}

describe("System Volume Resolution (VolumeConfig.system)", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("resolves system volume from SYSTEM_ORG when available", async () => {
    const volumeName = uniqueId("vol");
    const storageName = uniqueId("sys-vol");
    const { versionId } = await createTestVolumeForOrg(
      SYSTEM_ORG_ID,
      storageName,
    );

    const manifest = await prepareStorageManifest(
      systemVolumeConfig(volumeName, storageName, { system: true }),
      {},
      user.orgId,
      user.orgId,
      user.userId,
      [],
    );

    expect(manifest.storages).toHaveLength(1);
    expect(manifest.storages[0]!.vasStorageName).toBe(storageName);
    expect(manifest.storages[0]!.vasVersionId).toBe(versionId);
  });

  it("falls back to agent org when system volume not in SYSTEM_ORG", async () => {
    const volumeName = uniqueId("vol");
    const storageName = uniqueId("sys-fallback");
    const { versionId } = await createTestVolume(storageName);

    const manifest = await prepareStorageManifest(
      systemVolumeConfig(volumeName, storageName, { system: true }),
      {},
      user.orgId,
      user.orgId,
      user.userId,
      [],
    );

    expect(manifest.storages).toHaveLength(1);
    expect(manifest.storages[0]!.vasStorageName).toBe(storageName);
    expect(manifest.storages[0]!.vasVersionId).toBe(versionId);
  });

  it("prefers SYSTEM_ORG over agent org when both have the volume", async () => {
    const volumeName = uniqueId("vol");
    const storageName = uniqueId("sys-priority");
    const { versionId: systemVersionId } = await createTestVolumeForOrg(
      SYSTEM_ORG_ID,
      storageName,
    );
    await createTestVolume(storageName);

    const manifest = await prepareStorageManifest(
      systemVolumeConfig(volumeName, storageName, { system: true }),
      {},
      user.orgId,
      user.orgId,
      user.userId,
      [],
    );

    expect(manifest.storages).toHaveLength(1);
    expect(manifest.storages[0]!.vasVersionId).toBe(systemVersionId);
  });

  it("skips optional system volume silently when missing in both orgs", async () => {
    const volumeName = uniqueId("vol");
    const storageName = uniqueId("missing-sys");

    const manifest = await prepareStorageManifest(
      systemVolumeConfig(volumeName, storageName, {
        system: true,
        optional: true,
      }),
      {},
      user.orgId,
      user.orgId,
      user.userId,
      [],
    );

    expect(manifest.storages).toHaveLength(0);
  });

  it("resolves non-system compose volume from agent org only", async () => {
    const volumeName = uniqueId("vol");
    const storageName = uniqueId("nonsys-vol");
    const { versionId } = await createTestVolume(storageName);

    const manifest = await prepareStorageManifest(
      systemVolumeConfig(volumeName, storageName, { system: false }),
      {},
      user.orgId,
      user.orgId,
      user.userId,
      [],
    );

    expect(manifest.storages).toHaveLength(1);
    expect(manifest.storages[0]!.vasStorageName).toBe(storageName);
    expect(manifest.storages[0]!.vasVersionId).toBe(versionId);
  });
});
