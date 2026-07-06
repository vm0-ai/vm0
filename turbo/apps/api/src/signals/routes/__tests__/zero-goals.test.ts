import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { chatThreadsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { zeroGoalsContract } from "@vm0/api-contracts/contracts/zero-goals";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { createStore } from "ccstate";

import { mockOptionalEnv } from "../../../lib/env";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { now } from "../../external/time";
import {
  deleteUsageInsightFixture$,
  seedChatThread$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/zero-feature-switches";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const ALL_GOAL_CAPABILITIES = [
  "goal:read",
  "goal:agent-result:write",
  "goal:user-control:write",
] as const satisfies readonly ZeroCapability[];

interface GoalApiFixture extends UsageInsightFixture {
  readonly runId: string;
  readonly threadId: string;
  readonly agentId: string;
}

const track = createFixtureTracker<GoalApiFixture>(async (fixture) => {
  await deleteFeatureSwitchesForUser(context, fixture);
  await store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

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

async function seedGoalApiFixture(args: {
  readonly featureEnabled: boolean;
}): Promise<GoalApiFixture> {
  const fixture = await store.set(
    seedUsageInsightFixture$,
    undefined,
    context.signal,
  );
  await store.set(
    seedOrgMembership$,
    { orgId: fixture.orgId, userId: fixture.userId, role: "member" },
    context.signal,
  );
  const compose = await store.set(
    seedCompose$,
    { orgId: fixture.orgId, userId: fixture.userId },
    context.signal,
  );
  const threadId = await store.set(
    seedChatThread$,
    { userId: fixture.userId, composeId: compose.composeId },
    context.signal,
  );
  const run = await store.set(
    seedRun$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      composeId: compose.composeId,
      chatThreadId: threadId,
      triggerSource: "web",
      status: "running",
    },
    context.signal,
  );
  // The switch is globally enabled since the automation -> workflow cutover
  // (#19959); featureEnabled: false now needs an explicit user override to
  // exercise the disabled path.
  await updateFeatureSwitchesForUser(context, fixture, {
    [FeatureSwitchKey.WorkflowAutomation]: args.featureEnabled,
  });
  return await track(
    Promise.resolve({
      ...fixture,
      runId: run.runId,
      threadId,
      agentId: compose.agentId,
    }),
  );
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

  it("rejects goal writes while the feature switch is disabled", async () => {
    const fixture = await seedGoalApiFixture({ featureEnabled: false });

    const response = await accept(
      goalsClient().create({
        headers: headers(fixture, ["goal:user-control:write"]),
        body: { objective: "finish the release" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Goal workflows are not enabled",
        code: "FORBIDDEN",
      },
    });
  });

  it("exposes lifecycle transitions through the goal API", async () => {
    const fixture = await seedGoalApiFixture({ featureEnabled: true });

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

  it("edits a blocked goal back to active and replaces a completed goal", async () => {
    const fixture = await seedGoalApiFixture({ featureEnabled: true });
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
    const fixture = await seedGoalApiFixture({ featureEnabled: true });
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
    const fixture = await seedGoalApiFixture({ featureEnabled: true });
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

  it("clears the current goal and writes a cleared marker", async () => {
    const fixture = await seedGoalApiFixture({ featureEnabled: true });
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
    const fixture = await seedGoalApiFixture({ featureEnabled: true });
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
    const fixture = await seedGoalApiFixture({ featureEnabled: true });
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
    const fixture = await seedGoalApiFixture({ featureEnabled: true });
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
