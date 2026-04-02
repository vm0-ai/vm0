import { describe, it, expect, beforeEach } from "vitest";
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
import { SYSTEM_ORG_ID } from "@vm0/core";
import type { AgentVolumeConfig } from "../types";

const context = testContext();

/** Build a skill GitHub URL with a unique suffix */
function uniqueSkillUrl(): {
  url: string;
  storageName: string;
} {
  const suffix = uniqueId("skill");
  const url = `https://github.com/test-org/test-repo/tree/main/${suffix}`;
  const storageName = `agent-skills@test-org/test-repo/tree/main/${suffix}`;
  return { url, storageName };
}

/** Agent config that produces a single skill volume */
function skillAgentConfig(skillUrl: string): AgentVolumeConfig {
  return {
    agents: {
      "test-agent": {
        skills: [skillUrl],
      },
    },
  };
}

/** Agent config that produces a regular (non-skill) volume */
function regularVolumeConfig(
  volumeName: string,
  storageName: string,
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
      },
    },
  };
}

describe("System Skill Resolution", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("should resolve skill from system org when available", async () => {
    const { url, storageName } = uniqueSkillUrl();

    // Create skill storage under SYSTEM_ORG_ID
    const { versionId } = await createTestVolumeForOrg(
      SYSTEM_ORG_ID,
      storageName,
    );

    const manifest = await prepareStorageManifest(
      skillAgentConfig(url),
      {},
      user.orgId,
      user.orgId,
      user.userId,
    );

    expect(manifest.storages).toHaveLength(1);
    expect(manifest.storages[0]!.vasStorageName).toBe(storageName);
    expect(manifest.storages[0]!.vasVersionId).toBe(versionId);
  });

  it("should fall back to agent org when skill not in system org", async () => {
    const { url, storageName } = uniqueSkillUrl();

    // Create skill storage under agent's org (NOT system org)
    const { versionId } = await createTestVolume(storageName);

    const manifest = await prepareStorageManifest(
      skillAgentConfig(url),
      {},
      user.orgId,
      user.orgId,
      user.userId,
    );

    expect(manifest.storages).toHaveLength(1);
    expect(manifest.storages[0]!.vasStorageName).toBe(storageName);
    expect(manifest.storages[0]!.vasVersionId).toBe(versionId);
  });

  it("should resolve regular volumes from agent org only", async () => {
    const volumeName = uniqueId("vol");
    const storageName = uniqueId("storage");

    // Create regular volume under agent's org
    await createTestVolume(storageName);

    const manifest = await prepareStorageManifest(
      regularVolumeConfig(volumeName, storageName),
      {},
      user.orgId,
      user.orgId,
      user.userId,
    );

    expect(manifest.storages).toHaveLength(1);
    expect(manifest.storages[0]!.vasStorageName).toBe(storageName);
  });

  it("should throw when skill not found in any org", async () => {
    const { url } = uniqueSkillUrl();

    await expect(
      prepareStorageManifest(
        skillAgentConfig(url),
        {},
        user.orgId,
        user.orgId,
        user.userId,
      ),
    ).rejects.toThrow("not found");
  });
});
