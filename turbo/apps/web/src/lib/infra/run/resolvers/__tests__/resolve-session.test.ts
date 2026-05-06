import { describe, it, expect, beforeEach } from "vitest";
import { resolveSession } from "../resolve-session";
import {
  createTestCheckpoint,
  createTestCompose,
  createTestRun,
  setTestRunStatus,
} from "../../../../../__tests__/api-test-helpers";
import {
  createTestSessionWithConversation,
  setTestSessionArtifacts,
  setTestSessionFramework,
} from "../../../../../__tests__/db-test-seeders/agents";
import { setTestCheckpointArtifactSnapshots } from "../../../../../__tests__/db-test-seeders/runs";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../__tests__/test-helpers";

const context = testContext();

const WORKING_DIR = "/home/user/workspace";

describe("resolveSession — artifacts passthrough", () => {
  let user: UserContext;
  let composeId: string;
  let composeVersionId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const compose = await createTestCompose(uniqueId("sess-resolver"));
    composeId = compose.composeId;
    composeVersionId = compose.versionId;
  });

  it("returns session.artifacts verbatim from the DB", async () => {
    const { id: agentSessionId } = await createTestSessionWithConversation(
      user.userId,
      composeId,
      composeVersionId,
      "claude-code",
    );
    const entries = [
      { name: "mem", version: "latest", mountPath: "/opt/mem" },
      { name: "ctx", version: "latest", mountPath: WORKING_DIR },
    ];
    await setTestSessionArtifacts(agentSessionId, entries);

    const resolution = await resolveSession(agentSessionId, user.userId);

    expect(resolution.artifacts).toEqual(entries);
  });

  it("returns empty artifact list when session has no artifacts", async () => {
    const { id: agentSessionId } = await createTestSessionWithConversation(
      user.userId,
      composeId,
      composeVersionId,
      "claude-code",
    );
    await setTestSessionArtifacts(agentSessionId, []);

    const resolution = await resolveSession(agentSessionId, user.userId);

    expect(resolution.artifacts).toEqual([]);
  });

  it("populates sessionFramework from conversation.cliAgentType", async () => {
    const { id: agentSessionId } = await createTestSessionWithConversation(
      user.userId,
      composeId,
      composeVersionId,
      "claude-code",
    );
    await setTestSessionFramework(agentSessionId, "codex");

    const resolution = await resolveSession(agentSessionId, user.userId);

    expect(resolution.sessionFramework).toBe("codex");
  });

  it("uses checkpoint artifacts when continuing a recoverable failed session", async () => {
    const additionalVolumeMountPath =
      "/home/user/.claude/projects/-home-user-workspace/memory";
    const { runId } = await createTestRun(composeId, "failed recovery run", {
      additionalVolumes: [
        {
          name: "memory",
          version: "mem-base",
          mountPath: additionalVolumeMountPath,
        },
      ],
    });
    const { agentSessionId, checkpointId } = await createTestCheckpoint(
      user.userId,
      runId,
      {
        volumeVersionsSnapshot: {
          versions: { workspace: "vol-failed", memory: "mem-failed" },
          additionalVolumes: [
            {
              name: "memory",
              versionId: "mem-failed",
              mountPath: additionalVolumeMountPath,
            },
          ],
        },
      },
    );
    await setTestRunStatus(runId, "failed");
    await setTestSessionFramework(agentSessionId, "claude-code");
    await setTestSessionArtifacts(agentSessionId, [
      { name: "stale", version: "latest", mountPath: WORKING_DIR },
    ]);

    const checkpointArtifacts = [
      { name: "workspace", version: "snap-failed", mountPath: WORKING_DIR },
    ];
    await setTestCheckpointArtifactSnapshots(checkpointId, checkpointArtifacts);

    const resolution = await resolveSession(agentSessionId, user.userId);

    expect(resolution.artifacts).toEqual(checkpointArtifacts);
    expect(resolution.volumeVersions).toEqual({
      workspace: "vol-failed",
      memory: "mem-failed",
    });
    expect(resolution.additionalVolumes).toEqual([
      {
        name: "memory",
        version: "mem-failed",
        mountPath: additionalVolumeMountPath,
      },
    ]);
  });

  it("does not use checkpoint artifacts while the linked run is still running", async () => {
    const { runId } = await createTestRun(composeId, "in-flight recovery run");
    const { agentSessionId, checkpointId } = await createTestCheckpoint(
      user.userId,
      runId,
    );
    await setTestSessionFramework(agentSessionId, "claude-code");
    const sessionArtifacts = [
      { name: "session", version: "latest", mountPath: WORKING_DIR },
    ];
    await setTestSessionArtifacts(agentSessionId, sessionArtifacts);
    await setTestCheckpointArtifactSnapshots(checkpointId, [
      { name: "checkpoint", version: "snap", mountPath: WORKING_DIR },
    ]);

    const resolution = await resolveSession(agentSessionId, user.userId);

    expect(resolution.artifacts).toEqual(sessionArtifacts);
    expect(resolution.volumeVersions).toBeUndefined();
  });
});
