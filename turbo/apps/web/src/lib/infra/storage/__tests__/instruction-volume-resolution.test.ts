import { describe, it, expect, beforeEach } from "vitest";
// eslint-disable-next-line web/no-direct-db-in-tests -- Internal infrastructure: no API route
import { prepareStorageManifest } from "../storage-service";
import { createTestVolume } from "../../../../__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../__tests__/test-helpers";
import type { AgentVolumeConfig } from "../types";
import { getInstructionsStorageName } from "@vm0/core/storage-names";

const context = testContext();

function instructionConfig(agentName: string): AgentVolumeConfig {
  return {
    agents: {
      [agentName]: {
        framework: "claude-code",
        instructions: "CLAUDE.md",
      },
    },
  };
}

describe("Instruction Volume Resolution", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("mounts instructions using the compose framework by default", async () => {
    const agentName = uniqueId("instructions-agent");
    const storageName = getInstructionsStorageName(agentName);
    const { versionId } = await createTestVolume(storageName);

    const manifest = await prepareStorageManifest(
      instructionConfig(agentName),
      {},
      user.orgId,
      user.orgId,
      user.userId,
      [],
    );

    expect(manifest.storages).toHaveLength(1);
    expect(manifest.storages[0]!.vasStorageName).toBe(storageName);
    expect(manifest.storages[0]!.vasVersionId).toBe(versionId);
    expect(manifest.storages[0]!.mountPath).toBe("/home/user/.claude");
  });

  it("mounts instructions using the runtime framework override", async () => {
    const agentName = uniqueId("runtime-instructions-agent");
    const storageName = getInstructionsStorageName(agentName);
    const { versionId } = await createTestVolume(storageName);

    const manifest = await prepareStorageManifest(
      instructionConfig(agentName),
      {},
      user.orgId,
      user.orgId,
      user.userId,
      [],
      undefined,
      undefined,
      "codex",
    );

    expect(manifest.storages).toHaveLength(1);
    expect(manifest.storages[0]!.vasStorageName).toBe(storageName);
    expect(manifest.storages[0]!.vasVersionId).toBe(versionId);
    expect(manifest.storages[0]!.mountPath).toBe("/home/user/.codex");
  });
});
