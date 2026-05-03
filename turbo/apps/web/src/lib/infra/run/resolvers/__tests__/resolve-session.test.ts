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
    const entries = [
      { name: "mem", version: "latest", mountPath: "/opt/mem" },
      { name: "ctx", version: "latest", mountPath: WORKING_DIR },
    ];
    await setTestSessionArtifacts(agentSessionId, entries);

    const resolution = await resolveSession(agentSessionId, user.userId);

    expect(resolution.artifacts).toEqual(entries);
  });

  it("returns empty artifact list when session has no artifacts", async () => {
    const { runId } = await createTestRun(composeId, "empty session run");
    const { agentSessionId } = await completeTestRun(user.userId, runId);
    await setTestSessionFramework(agentSessionId, "claude-code");
    await setTestSessionArtifacts(agentSessionId, []);

    const resolution = await resolveSession(agentSessionId, user.userId);

    expect(resolution.artifacts).toEqual([]);
  });

  it("populates sessionFramework from conversation.cliAgentType", async () => {
    const { runId } = await createTestRun(composeId, "framework field run");
    const { agentSessionId } = await completeTestRun(user.userId, runId);
    await setTestSessionFramework(agentSessionId, "codex");

    const resolution = await resolveSession(agentSessionId, user.userId);

    expect(resolution.sessionFramework).toBe("codex");
  });
});
