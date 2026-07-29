import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { chatThreadsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { zeroGoalsContract } from "@vm0/api-contracts/contracts/zero-goals";

import { mockOptionalEnv } from "../../../lib/env";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  admitGoalQueueEventFixture,
  readGoalQueueStateFixture,
  readGoalThreadFixture,
} from "../../../test-fixtures/goal-queue";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { now } from "../../external/time";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const mocks = createZeroRouteMocks(context);

const ALL_GOAL_CAPABILITIES = [
  "goal:read",
  "goal:agent-result:write",
  "goal:user-control:write",
] as const satisfies readonly ZeroCapability[];

interface GoalApiFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly agentId: string;
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function goalsClient() {
  return setupApp({ context })(zeroGoalsContract);
}

function zeroToken(
  fixture: GoalApiFixture,
  capabilities: readonly ZeroCapability[],
): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: fixture.userId,
    orgId: fixture.orgId,
    runId: fixture.runId,
    capabilities: [...capabilities],
    iat: seconds,
    exp: seconds + 600,
  });
}

function headers(
  fixture: GoalApiFixture,
  capabilities: readonly ZeroCapability[] = ALL_GOAL_CAPABILITIES,
) {
  return { authorization: `Bearer ${zeroToken(fixture, capabilities)}` };
}

async function seedGoalApiFixture(): Promise<GoalApiFixture> {
  const bdd = createBddApi(context);
  const api = createRunsApi(context);
  const chat = createChatFilesBddApi(context);
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Goal fixtures require an org-scoped actor");
  }
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Goal Agent",
    visibility: "private",
  });
  const sent = await chat.requestSendEvent(
    actor,
    {
      agentId: agent.agentId,
      prompt: "goal precondition",
      model: "claude-sonnet-4-6",
    },
    [201],
  );
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected the chat send to create a thread-linked run");
  }
  return {
    orgId: actor.orgId,
    userId: actor.userId,
    runId: sent.body.runId,
    threadId: sent.body.threadId,
    agentId: agent.agentId,
  };
}

async function createGoal(fixture: GoalApiFixture, objective = "ship goals") {
  return await accept(
    goalsClient().create({
      headers: headers(fixture),
      body: { objective },
    }),
    [201],
  );
}

async function readCurrentGoal(fixture: GoalApiFixture) {
  return await accept(
    goalsClient().get({
      headers: headers(fixture),
    }),
    [200],
  );
}

async function readThreadGoalWithSession(fixture: GoalApiFixture) {
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
  return await accept(
    goalsClient().getForChatThread({
      headers: { authorization: "Bearer clerk-session" },
      params: { threadId: fixture.threadId },
    }),
    [200],
  );
}

describe("zero goals", () => {
  beforeEach(() => {
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  });

  it("exposes lifecycle transitions through the goal API", async () => {
    const fixture = await seedGoalApiFixture();

    const created = await createGoal(fixture, "ship thread goals");
    expect(created.body).toStrictEqual({
      objective: "ship thread goals",
      objectiveBrief: "ship thread goals",
      status: "active",
    });
    await expect(readCurrentGoal(fixture)).resolves.toMatchObject({
      body: created.body,
    });

    const duplicate = await accept(
      goalsClient().create({
        headers: headers(fixture),
        body: { objective: "try another goal" },
      }),
      [409],
    );
    expect(duplicate.body.error.message).toContain("existing goal");

    const blocked = await accept(
      goalsClient().block({ headers: headers(fixture) }),
      [200],
    );
    expect(blocked.body.status).toBe("blocked");
    await expect(readCurrentGoal(fixture)).resolves.toMatchObject({
      body: { status: "blocked" },
    });

    const resumed = await accept(
      goalsClient().resume({ headers: headers(fixture) }),
      [200],
    );
    expect(resumed.body.status).toBe("active");
    await expect(readCurrentGoal(fixture)).resolves.toMatchObject({
      body: { status: "active", objectiveBrief: "ship thread goals" },
    });

    const completed = await accept(
      goalsClient().complete({ headers: headers(fixture) }),
      [200],
    );
    expect(completed.body.status).toBe("complete");
    await expect(readCurrentGoal(fixture)).resolves.toMatchObject({
      body: { status: "complete" },
    });
  });

  it("bootstraps a provisioned goal thread through a claimed input.goal event", async () => {
    const bdd = createBddApi(context);
    const api = createRunsApi(context);
    const chat = createChatFilesBddApi(context);
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Goal bootstrap requires an org-scoped actor");
    }
    bdd.acceptAgentStorageWrites();
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    api.configureRunnerGroup();
    await api.grantProEntitlement(actor);
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "Goal Bootstrap Agent",
      visibility: "private",
    });
    const origin = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "create a goal outside chat",
      modelProvider: "anthropic-api-key",
    });

    const created = await accept(
      goalsClient().create({
        headers: headers({
          orgId: actor.orgId,
          userId: actor.userId,
          runId: origin.runId,
          threadId: "",
          agentId: agent.agentId,
        }),
        body: { objective: "bootstrap autonomously" },
      }),
      [201],
    );
    expect(created.body.status).toBe("active");

    const goal = await readGoalThreadFixture({
      orgId: actor.orgId,
      userId: actor.userId,
      agentId: agent.agentId,
    });
    if (!goal) {
      throw new Error("Expected the provisioned thread goal");
    }

    let goalRunId: string | undefined;
    await expect
      .poll(async () => {
        const state = await readGoalQueueStateFixture(goal.threadId);
        goalRunId = state.runIds[0];
        return goalRunId;
      })
      .toBeDefined();
    if (!goalRunId) {
      throw new Error("Expected the bootstrapped goal run");
    }

    const state = await readGoalQueueStateFixture(goal.threadId);
    const goalEventId = state.eventIds[0];
    if (!goalEventId) {
      throw new Error("Expected the bootstrap input.goal source event");
    }

    const page = await chat.listThreadEvents(actor, goal.threadId);
    expect(
      page.events.map((event) => {
        return event.id;
      }),
    ).not.toContain(goalEventId);
    expect(page.events).toContainEqual(
      expect.objectContaining({
        eventType: "input.prompt",
        runId: goalRunId,
        revokesEventId: goalEventId,
        isGoalRun: true,
        goalSnapshot: { objectiveBrief: "bootstrap autonomously" },
      }),
    );
    expect(state.runIds).toHaveLength(1);

    await api.requestCancelRun(actor, goalRunId, [200]);
    await api.requestCancelRun(actor, origin.runId, [200]);
  }, 60_000);

  it("coalesces repeated goal queue admission to one unclaimed event per thread", async () => {
    const fixture = await seedGoalApiFixture();
    await createGoal(fixture, "coalesce goal triggers");
    const goal = await readGoalThreadFixture({
      orgId: fixture.orgId,
      userId: fixture.userId,
      threadId: fixture.threadId,
    });
    if (!goal) {
      throw new Error("Expected the active goal");
    }
    const kms = useSecretKmsProbe();

    const first = await admitGoalQueueEventFixture({
      threadId: fixture.threadId,
      orgId: fixture.orgId,
      userId: fixture.userId,
      goalId: goal.goalId,
      objectiveBrief: "coalesce goal triggers",
      callbackSecret: "first-callback-secret",
    });
    const second = await admitGoalQueueEventFixture({
      threadId: fixture.threadId,
      orgId: fixture.orgId,
      userId: fixture.userId,
      goalId: goal.goalId,
      objectiveBrief: "coalesce goal triggers",
      callbackSecret: "second-callback-secret",
    });

    expect(first.kind).toBe("inserted");
    expect(second).toStrictEqual({ kind: "coalesced" });
    expect(kms.generateDataKeyCalls).toBe(1);
    const state = await readGoalQueueStateFixture(fixture.threadId);
    expect(state.eventIds).toHaveLength(1);
  });

  it("edits a blocked goal back to active and replaces a completed goal", async () => {
    const fixture = await seedGoalApiFixture();
    await createGoal(fixture, "ship goals");

    await accept(goalsClient().block({ headers: headers(fixture) }), [200]);
    const edited = await accept(
      goalsClient().edit({
        headers: headers(fixture, ["goal:user-control:write"]),
        body: { objective: "ship goals v2" },
      }),
      [200],
    );
    expect(edited.body).toStrictEqual({
      objective: "ship goals v2",
      objectiveBrief: "ship goals v2",
      status: "active",
    });

    await expect(readCurrentGoal(fixture)).resolves.toMatchObject({
      body: edited.body,
    });
    await accept(goalsClient().complete({ headers: headers(fixture) }), [200]);

    const replacement = await accept(
      goalsClient().edit({
        headers: headers(fixture, ["goal:user-control:write"]),
        body: { objective: "start the next goal" },
      }),
      [200],
    );
    expect(replacement.body).toMatchObject({
      objective: "start the next goal",
      objectiveBrief: "start the next goal",
      status: "active",
    });
    await expect(readCurrentGoal(fixture)).resolves.toMatchObject({
      body: replacement.body,
    });
  });

  it("pauses a chat thread goal with session auth", async () => {
    const fixture = await seedGoalApiFixture();
    await createGoal(fixture, "ship thread goals");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const paused = await accept(
      goalsClient().pauseForChatThread({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: fixture.threadId },
      }),
      [200],
    );

    expect(paused.body.status).toBe("paused");
    await expect(readThreadGoalWithSession(fixture)).resolves.toMatchObject({
      body: { status: "paused" },
    });
  });

  it("reads a chat thread goal with session auth", async () => {
    const fixture = await seedGoalApiFixture();
    const objective =
      "# Ship goals\n\nKeep the release moving with **daily** checks.";
    await createGoal(fixture, objective);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const response = await accept(
      goalsClient().getForChatThread({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: fixture.threadId },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      objective,
      objectiveBrief: "Ship goals",
      status: "active",
    });
  });

  it("truncates long Unicode objective briefs without splitting codepoints", async () => {
    const fixture = await seedGoalApiFixture();
    const chat = createChatFilesBddApi(context);
    const rareLetter = "\u{10400}";
    const objective = rareLetter.repeat(200);
    const expectedBrief = `${rareLetter.repeat(137)}...`;
    const created = await createGoal(fixture, objective);

    expect(created.body).toStrictEqual({
      objective,
      objectiveBrief: expectedBrief,
      status: "active",
    });
    for (const char of created.body.objectiveBrief) {
      expect(char === rareLetter || char === ".").toBeTruthy();
    }

    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const messages = await chat.listThreadEvents(
      {
        userId: fixture.userId,
        orgId: fixture.orgId,
        orgRole: "org:member",
        email: "goal-user@example.com",
      },
      fixture.threadId,
    );
    expect(messages.events).toContainEqual(
      expect.objectContaining({
        eventType: "goal.changed",
        goalEvent: {
          type: "state",
          status: "active",
          objectiveBrief: expectedBrief,
        },
      }),
    );
  });

  it("keeps Unicode objective briefs at the codepoint limit untruncated", async () => {
    const fixture = await seedGoalApiFixture();
    const rareLetter = "\u{10400}";
    const objective = rareLetter.repeat(140);
    const created = await createGoal(fixture, objective);

    expect(created.body).toStrictEqual({
      objective,
      objectiveBrief: objective,
      status: "active",
    });
  });

  it("keeps markdown-only goal objective briefs non-empty", async () => {
    const fixture = await seedGoalApiFixture();
    const chat = createChatFilesBddApi(context);
    const created = await createGoal(fixture, "---");

    expect(created.body).toStrictEqual({
      objective: "---",
      objectiveBrief: "---",
      status: "active",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const messages = await chat.listThreadEvents(
      {
        userId: fixture.userId,
        orgId: fixture.orgId,
        orgRole: "org:member",
        email: "goal-user@example.com",
      },
      fixture.threadId,
    );
    expect(messages.events).toContainEqual(
      expect.objectContaining({
        eventType: "goal.changed",
        goalEvent: {
          type: "state",
          status: "active",
          objectiveBrief: "---",
        },
      }),
    );
  });

  it("clears the current goal and writes a cleared marker", async () => {
    const fixture = await seedGoalApiFixture();
    await createGoal(fixture, "ship thread goals");

    const cleared = await accept(
      goalsClient().clear({
        headers: headers(fixture, ["goal:user-control:write"]),
      }),
      [200],
    );

    expect(cleared.body).toStrictEqual({ cleared: true });
    const missing = await accept(
      goalsClient().get({ headers: headers(fixture) }),
      [404],
    );
    expect(missing.body.error.code).toBe("NOT_FOUND");
  });

  it("enforces user-control and agent-result capability boundaries", async () => {
    const fixture = await seedGoalApiFixture();
    await createGoal(fixture, "ship thread goals");

    const editDenied = await accept(
      goalsClient().edit({
        headers: headers(fixture, ["goal:read", "goal:agent-result:write"]),
        body: { objective: "should be forbidden" },
      }),
      [403],
    );
    expect(editDenied.body.error.message).toContain("goal:user-control:write");

    const completeDenied = await accept(
      goalsClient().complete({
        headers: headers(fixture, ["goal:read", "goal:user-control:write"]),
      }),
      [403],
    );
    expect(completeDenied.body.error.message).toContain(
      "goal:agent-result:write",
    );
  });

  it("rejects stale autonomous goal result writes without user-control capability", async () => {
    const fixture = await seedGoalApiFixture();
    await createGoal(fixture, "ship thread goals");

    const stale = await accept(
      goalsClient().block({
        headers: headers(fixture, ["goal:agent-result:write"]),
      }),
      [409],
    );
    expect(stale.body.error.message).toBe(
      "The goal changed after this run started",
    );

    await expect(readCurrentGoal(fixture)).resolves.toMatchObject({
      body: { status: "active" },
    });
  });

  it("excludes goal-state markers from a thread's unread state", async () => {
    const fixture = await seedGoalApiFixture();
    await createGoal(fixture, "ship thread goals");

    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const unreads = await accept(
      setupApp({ context })(chatThreadsContract).unreads({
        headers: { authorization: "Bearer clerk-session" },
        query: { agentId: fixture.agentId },
      }),
      [200],
    );

    expect(
      unreads.body.unreads.map((unread) => {
        return unread.threadId;
      }),
    ).not.toContain(fixture.threadId);
  });
});
