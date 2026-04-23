import { describe, it, expect, beforeEach } from "vitest";
import { resolveCheckpoint } from "../resolve-checkpoint";
import {
  createTestCheckpoint,
  createTestCompose,
  createTestRun,
} from "../../../../../__tests__/api-test-helpers";
import { setTestCheckpointArtifactSnapshots } from "../../../../../__tests__/db-test-seeders/runs";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../__tests__/test-helpers";
import {
  AUTO_MEMORY_ARTIFACT_NAME,
  AUTO_MEMORY_MOUNT_PATH,
} from "../../../storage/types";
import type { ContextArtifact } from "../../types";

const context = testContext();

const WORKING_DIR = "/home/user/workspace";

describe("resolveCheckpoint — artifactSnapshots shape tolerance", () => {
  let user: UserContext;
  let composeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const compose = await createTestCompose(uniqueId("cp-resolver"));
    composeId = compose.composeId;
  });

  it("decodes legacy Record<name, version> via mountPath heuristic", async () => {
    const { runId } = await createTestRun(composeId, "legacy shape run");
    const { checkpointId } = await createTestCheckpoint(user.userId, runId);

    await setTestCheckpointArtifactSnapshots(checkpointId, {
      [AUTO_MEMORY_ARTIFACT_NAME]: "v-mem",
      "my-artifact": "v-art",
    });

    const resolution = await resolveCheckpoint(checkpointId, user.userId);

    expect(resolution.artifacts).toHaveLength(2);
    const byName = Object.fromEntries(
      resolution.artifacts.map((a) => {
        return [a.name, a];
      }),
    );
    expect(byName[AUTO_MEMORY_ARTIFACT_NAME]).toEqual({
      name: AUTO_MEMORY_ARTIFACT_NAME,
      version: "v-mem",
      mountPath: AUTO_MEMORY_MOUNT_PATH,
    });
    expect(byName["my-artifact"]).toEqual({
      name: "my-artifact",
      version: "v-art",
      mountPath: WORKING_DIR,
    });
  });

  it("passes new-shape ContextArtifact[] through unchanged", async () => {
    const { runId } = await createTestRun(composeId, "new shape run");
    const { checkpointId } = await createTestCheckpoint(user.userId, runId);

    const newShape: ContextArtifact[] = [
      { name: "m", version: "v", mountPath: "/custom/mount" },
      { name: "n", version: "w", mountPath: "/another" },
    ];

    await setTestCheckpointArtifactSnapshots(checkpointId, newShape);

    const resolution = await resolveCheckpoint(checkpointId, user.userId);

    expect(resolution.artifacts).toEqual(newShape);
  });

  it("returns empty artifact list when artifactSnapshots is null", async () => {
    const { runId } = await createTestRun(composeId, "null snapshot run");
    const { checkpointId } = await createTestCheckpoint(user.userId, runId);

    await setTestCheckpointArtifactSnapshots(checkpointId, null);

    const resolution = await resolveCheckpoint(checkpointId, user.userId);

    expect(resolution.artifacts).toEqual([]);
  });

  it("rejects malformed array entries with a descriptive error", async () => {
    const { runId } = await createTestRun(composeId, "malformed array run");
    const { checkpointId } = await createTestCheckpoint(user.userId, runId);

    // Array-shape snapshot with a malformed entry (missing mountPath).
    // Bypass the ContextArtifact type so we can stuff a bad payload into jsonb.
    await setTestCheckpointArtifactSnapshots(checkpointId, [
      { name: "bad" },
    ] as unknown as ContextArtifact[]);

    await expect(resolveCheckpoint(checkpointId, user.userId)).rejects.toThrow(
      /artifactSnapshots\[0\]/,
    );
  });

  it("rejects legacy Record entries with non-string versions", async () => {
    const { runId } = await createTestRun(composeId, "malformed record run");
    const { checkpointId } = await createTestCheckpoint(user.userId, runId);

    // Legacy Record shape where a version is not a string.
    await setTestCheckpointArtifactSnapshots(checkpointId, {
      bad: 42,
    } as unknown as Record<string, string>);

    await expect(resolveCheckpoint(checkpointId, user.userId)).rejects.toThrow(
      /"bad"/,
    );
  });
});
