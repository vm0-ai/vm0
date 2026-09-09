import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { goalsContract } from "@okouai/api-contracts/contracts/goals";
import { HttpResponse, http } from "msw";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  admitGoalQueueEventFixture,
  activateLegacyGoalPiFixture,
  claimPreparedGoalFixture,
  drainChatThreadQueueFixture,
  readGoalQueueStateFixture,
  readGoalThreadFixture,
  seedGoalForRunFixture,
  setLegacyGoalRunOriginFixture,
} from "../../../test-fixtures/goal-queue";
import { holdAgentRunRowLockFixture } from "../../../test-fixtures/chat-events";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { goalsRoutes } from "../goals";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import {
  readThreadGoalAutonomyBudgetFixture,
  setRunAutonomyBudgetFixture,
} from "./helpers/runtime-state";

const context = testContext();
const mocks = createRouteMocks(context);

const ALL_GOAL_CAPABILITIES = [
  "goal:read",
  "goal:agent-result:write",
  "goal:user-control:write",
] as const satisfies readonly Capability[];

interface GoalApiAuthFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly agentId: string;
}

interface GoalApiFixture extends GoalApiAuthFixture {
  readonly actor: ApiTestUser;
  readonly runnerGroup: string;
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function goalsClient() {
  return setupApp({ context, routes: goalsRoutes })(goalsContract);
}

function okouToken(
  fixture: GoalApiAuthFixture,
  capabilities: readonly Capability[],
): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "okou",
    userId: fixture.userId,
    orgId: fixture.orgId,
    runId: fixture.runId,
    capabilities: [...capabilities],
    iat: seconds,
    exp: seconds + 600,
  });
}

function headers(
  fixture: GoalApiAuthFixture,
  capabilities: readonly Capability[] = ALL_GOAL_CAPABILITIES,
) {
  return { authorization: `Bearer ${okouToken(fixture, capabilities)}` };
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
  const runnerGroup = api.configureRunnerGroup();
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
      model: "claude-sonnet-5",
    },
    [201],
  );
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected the chat send to create a thread-linked run");
  }
  await flushWaitUntilForTest();
  return {
    actor,
    runnerGroup,
    orgId: actor.orgId,
    userId: actor.userId,
    runId: sent.body.runId,
    threadId: sent.body.threadId,
    agentId: agent.agentId,
  };
}

const retiredMessage =
  "Okou Goals have been retired. Continue with a regular chat message.";

describe("Goal retirement compatibility", () => {
  it("rejects an old-client create before generating a brief or writing Goal state", async () => {
    const fixture = await seedGoalApiFixture();
    await setRunAutonomyBudgetFixture(context, fixture.runId, 0);
    mockOptionalEnv("OPENROUTER_API_KEY", "test-goal-retirement-key");
    let briefRequests = 0;
    server.use(
      http.post("https://openrouter.ai/api/v1/chat/completions", () => {
        briefRequests++;
        return HttpResponse.json(
          { error: "Goal briefing must not run" },
          { status: 500 },
        );
      }),
    );
    const chat = createChatFilesBddApi(context);
    const before = await chat.listThreadEvents(fixture.actor, fixture.threadId);
    const denied = await accept(
      goalsClient().create({
        headers: headers(fixture),
        body: { objective: "continue automatically" },
      }),
      [409],
    );
    expect(denied.body.error.message).toBe(retiredMessage);
    expect(briefRequests).toBe(0);
    await expect(
      readGoalThreadFixture({
        orgId: fixture.orgId,
        userId: fixture.userId,
        threadId: fixture.threadId,
      }),
    ).resolves.toBeNull();
    await expect(
      chat.listThreadEvents(fixture.actor, fixture.threadId),
    ).resolves.toStrictEqual(before);
    expect(
      (await readGoalQueueStateFixture(fixture.threadId)).runIds,
    ).toStrictEqual([]);
  });

  it.each(["active", "paused", "blocked", "complete"] as const)(
    "rejects edit and resume of a %s Goal without changing its row or markers",
    async (status) => {
      const fixture = await seedGoalApiFixture();
      const original = await seedGoalForRunFixture(
        fixture.runId,
        "historical objective",
        status,
      );
      await setRunAutonomyBudgetFixture(context, fixture.runId, 0);
      const chat = createChatFilesBddApi(context);
      const before = await chat.listThreadEvents(
        fixture.actor,
        fixture.threadId,
      );
      const edited = await accept(
        goalsClient().edit({
          headers: headers(fixture),
          body: { objective: "replacement objective" },
        }),
        [409],
      );
      const resumed = await accept(
        goalsClient().resume({ headers: headers(fixture) }),
        [409],
      );
      expect(edited.body.error.message).toBe(retiredMessage);
      expect(resumed.body.error.message).toBe(retiredMessage);
      const current = await accept(
        goalsClient().get({ headers: headers(fixture) }),
        [200],
      );
      expect(current.body).toStrictEqual({
        objective: original.objective,
        objectiveBrief: original.objectiveBrief,
        status,
      });
      await expect(
        readGoalThreadFixture({
          orgId: fixture.orgId,
          userId: fixture.userId,
          threadId: fixture.threadId,
        }),
      ).resolves.toStrictEqual({
        goalId: original.id,
        threadId: fixture.threadId,
      });
      await expect(
        chat.listThreadEvents(fixture.actor, fixture.threadId),
      ).resolves.toStrictEqual(before);
      await expect(
        readThreadGoalAutonomyBudgetFixture(context, fixture.threadId),
      ).resolves.toBe(9);
    },
  );

  it("preserves capability and run ownership checks before retirement responses", async () => {
    const fixture = await seedGoalApiFixture();
    await seedGoalForRunFixture(fixture.runId, "owned objective");
    const insufficient = headers(fixture, ["goal:read"]);
    expect(
      (
        await accept(
          goalsClient().create({
            headers: insufficient,
            body: { objective: "unauthorized" },
          }),
          [403],
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await accept(
          goalsClient().edit({
            headers: insufficient,
            body: { objective: "unauthorized" },
          }),
          [403],
        )
      ).status,
    ).toBe(403);
    expect(
      (await accept(goalsClient().resume({ headers: insufficient }), [403]))
        .status,
    ).toBe(403);
    const another = await seedGoalApiFixture();
    const forgedContext = headers({ ...another, runId: fixture.runId });
    expect(
      (
        await accept(
          goalsClient().edit({
            headers: forgedContext,
            body: { objective: "cross-owner" },
          }),
          [400],
        )
      ).status,
    ).toBe(400);
    mocks.clerk.session(another.userId, another.orgId, "org:member");
    expect(
      (
        await accept(
          goalsClient().getForChatThread({
            headers: { authorization: "Bearer clerk-session" },
            params: { threadId: fixture.threadId },
          }),
          [404],
        )
      ).status,
    ).toBe(404);
  });

  it("keeps read, pause and terminal compatibility without reactivation", async () => {
    const fixture = await seedGoalApiFixture();
    await seedGoalForRunFixture(fixture.runId, "in-flight objective");
    const paused = await accept(
      goalsClient().pause({ headers: headers(fixture) }),
      [200],
    );
    expect(paused.body.status).toBe("paused");
    const blocked = await accept(
      goalsClient().block({ headers: headers(fixture) }),
      [200],
    );
    expect(blocked.body.status).toBe("blocked");
    const completed = await accept(
      goalsClient().complete({ headers: headers(fixture) }),
      [200],
    );
    expect(completed.body.status).toBe("complete");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    expect(
      (
        await accept(
          goalsClient().getForChatThread({
            headers: { authorization: "Bearer clerk-session" },
            params: { threadId: fixture.threadId },
          }),
          [200],
        )
      ).body,
    ).toStrictEqual(completed.body);
    expect(
      (await accept(goalsClient().resume({ headers: headers(fixture) }), [409]))
        .body.error.message,
    ).toBe(retiredMessage);
    expect(
      (await readGoalQueueStateFixture(fixture.threadId)).runIds,
    ).toStrictEqual([]);
  });

  it("revokes old pending inputs exactly once even while another run is pending", async () => {
    const fixture = await seedGoalApiFixture();
    const goal = await seedGoalForRunFixture(
      fixture.runId,
      "old queued objective",
    );
    const event = await admitGoalQueueEventFixture({
      threadId: fixture.threadId,
      goalId: goal.id,
      objectiveBrief: goal.objectiveBrief,
    });
    if (event.kind !== "inserted") {
      throw new Error("Expected an old Goal input");
    }
    await drainChatThreadQueueFixture({
      threadId: fixture.threadId,
      signal: context.signal,
    });
    await drainChatThreadQueueFixture({
      threadId: fixture.threadId,
      signal: context.signal,
    });
    const events = await createChatFilesBddApi(context).listThreadEvents(
      fixture.actor,
      fixture.threadId,
    );
    expect(
      events.events.filter((item) => {
        return item.revokesEventId === event.eventId;
      }),
    ).toMatchObject([{ eventType: "control.revoke" }]);
    expect(
      (await readGoalQueueStateFixture(fixture.threadId)).runIds,
    ).toStrictEqual([]);
  });

  it("rejects a captured pending Goal runner job and retains its cancelled history", async () => {
    const fixture = await seedGoalApiFixture();
    const goal = await seedGoalForRunFixture(
      fixture.runId,
      "captured Goal job",
    );
    await setLegacyGoalRunOriginFixture(fixture.runId, goal.id);
    const api = createRunsApi(context);
    await api.heartbeatRunner(fixture.runnerGroup);
    const claim = await api.requestClaimRunnerJob(true, fixture.runId, [404]);
    expect(claim.status).toBe(404);
    const run = await api.readRun(fixture.actor, fixture.runId);
    expect(run.status).toBe("cancelled");
    expect(run.error).toBe(retiredMessage);
    expect(
      (await api.requestClaimRunnerJob(true, fixture.runId, [404])).status,
    ).toBe(404);
    const events = await createChatFilesBddApi(context).listThreadEvents(
      fixture.actor,
      fixture.threadId,
    );
    expect(
      events.events.filter((item) => {
        return item.eventType === "run.cancelled";
      }),
    ).toHaveLength(1);
  });

  it("does not treat a manual run's historical goal id as Goal execution authority", async () => {
    const fixture = await seedGoalApiFixture();
    const goal = await seedGoalForRunFixture(
      fixture.runId,
      "historical association",
    );
    await setLegacyGoalRunOriginFixture(fixture.runId, goal.id, "chat");
    await createRunsApi(context).heartbeatRunner(fixture.runnerGroup);
    const claim = await createRunsApi(context).requestClaimRunnerJob(
      true,
      fixture.runId,
      [200],
    );
    expect(claim.status).toBe(200);
    await createRunsApi(context).requestCancelRun(
      fixture.actor,
      fixture.runId,
      [200],
    );
  });
  it("leaves a Goal run running when its earlier claim wins the row lock", async () => {
    const fixture = await seedGoalApiFixture();
    const goal = await seedGoalForRunFixture(
      fixture.runId,
      "racing legacy claim",
    );
    await setLegacyGoalRunOriginFixture(fixture.runId, goal.id);
    const api = createRunsApi(context);
    await api.heartbeatRunner(fixture.runnerGroup);
    const lock = await holdAgentRunRowLockFixture({
      runId: fixture.runId,
      signal: context.signal,
      statusOnRelease: "running",
    });
    const claim = api.requestClaimRunnerJob(true, fixture.runId, [404]);
    onTestFinished(async () => {
      lock.release();
      await lock.done;
      await claim;
    });
    await expect.poll(lock.waiterCount).toBeGreaterThan(0);
    lock.release();
    await lock.done;
    expect((await claim).status).toBe(404);
    expect((await api.readRun(fixture.actor, fixture.runId)).status).toBe(
      "running",
    );
    const events = await createChatFilesBddApi(context).listThreadEvents(
      fixture.actor,
      fixture.threadId,
    );
    expect(
      events.events.filter((event) => {
        return event.eventType === "run.cancelled";
      }),
    ).toHaveLength(0);
    await api.requestCancelRun(fixture.actor, fixture.runId, [200]);
  });

  it("rejects an already-prepared final Goal claim without replacing its input", async () => {
    const fixture = await seedGoalApiFixture();
    const goal = await seedGoalForRunFixture(
      fixture.runId,
      "captured preparation",
    );
    const event = await admitGoalQueueEventFixture({
      threadId: fixture.threadId,
      goalId: goal.id,
      objectiveBrief: goal.objectiveBrief,
    });
    if (event.kind !== "inserted") {
      throw new Error("Expected a historical Goal input");
    }
    await expect(
      claimPreparedGoalFixture({
        goal,
        eventId: event.eventId,
        runId: fixture.runId,
      }),
    ).resolves.toBe("lost");
    await drainChatThreadQueueFixture({
      threadId: fixture.threadId,
      signal: context.signal,
    });
    const events = await createChatFilesBddApi(context).listThreadEvents(
      fixture.actor,
      fixture.threadId,
    );
    expect(
      events.events.filter((item) => {
        return item.revokesEventId === event.eventId;
      }),
    ).toMatchObject([{ eventType: "control.revoke" }]);
  });

  it("settles a captured API-owned Pi Goal before any provider request", async () => {
    const fixture = await seedGoalApiFixture();
    const goal = await seedGoalForRunFixture(
      fixture.runId,
      "old Pi activation",
    );
    await setLegacyGoalRunOriginFixture(fixture.runId, goal.id);
    let providerRequests = 0;
    server.use(
      http.post("https://api.openai.com/v1/responses", () => {
        providerRequests++;
        return HttpResponse.json(
          { error: "Retired Goal must not execute" },
          { status: 500 },
        );
      }),
    );
    await activateLegacyGoalPiFixture(fixture.runId, context.signal);
    expect(providerRequests).toBe(0);
    expect(
      (await createRunsApi(context).readRun(fixture.actor, fixture.runId))
        .status,
    ).toBe("cancelled");
  });
});
