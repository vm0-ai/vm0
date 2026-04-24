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
import type { ContextArtifact } from "../../types";

const context = testContext();

describe("resolveCheckpoint — artifactSnapshots decoding", () => {
  let user: UserContext;
  let composeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const compose = await createTestCompose(uniqueId("cp-resolver"));
    composeId = compose.composeId;
  });

  it("passes canonical ContextArtifact[] through unchanged", async () => {
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
});
