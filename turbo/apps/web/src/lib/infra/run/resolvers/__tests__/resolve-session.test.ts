import { describe, it, expect, beforeEach } from "vitest";
import { resolveSession } from "../resolve-session";
import {
  completeTestRun,
  createTestCompose,
  createTestRun,
} from "../../../../../__tests__/api-test-helpers";
import {
  setTestSessionArtifacts,
  setTestSessionFramework,
} from "../../../../../__tests__/db-test-seeders/agents";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../__tests__/test-helpers";
import {
  AUTO_MEMORY_ARTIFACT_NAME,
  AUTO_MEMORY_MOUNT_PATH,
} from "../../../storage/types";

const context = testContext();

const WORKING_DIR = "/home/user/workspace";

describe("resolveSession — artifacts passthrough", () => {
  let user: UserContext;
  let composeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const compose = await createTestCompose(uniqueId("sess-resolver"));
    composeId = compose.composeId;
  });

  it("returns session.artifacts verbatim from the DB", async () => {
    const { runId } = await createTestRun(composeId, "session expansion run");
    const { agentSessionId } = await completeTestRun(user.userId, runId);
    await setTestSessionFramework(agentSessionId, "claude-code");
    await setTestSessionArtifacts(agentSessionId, [
      {
        name: AUTO_MEMORY_ARTIFACT_NAME,
        version: "latest",
        mountPath: AUTO_MEMORY_MOUNT_PATH,
      },
      { name: "ctx", version: "latest", mountPath: WORKING_DIR },
    ]);

    const resolution = await resolveSession(agentSessionId, user.userId);

    expect(resolution.artifacts).toHaveLength(2);
    const byName = Object.fromEntries(
      resolution.artifacts.map((a) => {
        return [a.name, a];
      }),
    );
    expect(byName[AUTO_MEMORY_ARTIFACT_NAME]).toEqual({
      name: AUTO_MEMORY_ARTIFACT_NAME,
      version: "latest",
      mountPath: AUTO_MEMORY_MOUNT_PATH,
    });
    expect(byName["ctx"]).toEqual({
      name: "ctx",
      version: "latest",
      mountPath: WORKING_DIR,
    });
  });

  it("returns empty artifact list when session has no artifacts", async () => {
    const { runId } = await createTestRun(composeId, "empty session run");
    const { agentSessionId } = await completeTestRun(user.userId, runId);
    await setTestSessionFramework(agentSessionId, "claude-code");
    await setTestSessionArtifacts(agentSessionId, []);

    const resolution = await resolveSession(agentSessionId, user.userId);

    expect(resolution.artifacts).toEqual([]);
  });
});
