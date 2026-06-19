import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { zeroGoalsContract } from "@vm0/api-contracts/contracts/zero-goals";
import { zeroWorkflowsCollectionContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import {
  zeroWorkflowTriggers,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
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
import {
  deleteOrgMembership$,
  seedOrgMembership$,
} from "./helpers/zero-org-membership";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

interface GoalApiFixture extends UsageInsightFixture {
  readonly runId: string;
  readonly threadId: string;
  readonly agentId: string;
}

const track = createFixtureTracker<GoalApiFixture>(async (fixture) => {
  const db = store.set(writeDb$);
  await db.delete(zeroWorkflows).where(eq(zeroWorkflows.orgId, fixture.orgId));
  await store.set(deleteUsageInsightFixture$, fixture, context.signal);
  await store.set(deleteOrgMembership$, fixture, context.signal);
});

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function goalsClient() {
  return setupApp({ context })(zeroGoalsContract);
}

function workflowsClient() {
  return setupApp({ context })(zeroWorkflowsCollectionContract);
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
  capabilities: readonly ZeroCapability[] = ["goal:read", "goal:write"],
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
  if (args.featureEnabled) {
    await store
      .set(writeDb$)
      .insert(userFeatureSwitches)
      .values({
        orgId: fixture.orgId,
        userId: fixture.userId,
        switches: { [FeatureSwitchKey.GoalWorkflows]: true },
      });
  }
  return await track(
    Promise.resolve({
      ...fixture,
      runId: run.runId,
      threadId,
      agentId: compose.agentId,
    }),
  );
}

async function loadGoalRows(fixture: GoalApiFixture) {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({
      workflowId: zeroWorkflows.id,
      workflowName: zeroWorkflows.name,
      workflowType: zeroWorkflows.type,
      active: zeroWorkflows.active,
      visibility: zeroWorkflows.visibility,
      preference: zeroWorkflows.preference,
      triggerId: zeroWorkflowTriggers.id,
      kind: zeroWorkflowTriggers.kind,
      eventType: zeroWorkflowTriggers.eventType,
      scheduleType: zeroWorkflowTriggers.scheduleType,
      nextRunAt: zeroWorkflowTriggers.nextRunAt,
      enabled: zeroWorkflowTriggers.enabled,
      consecutiveFailures: zeroWorkflowTriggers.consecutiveFailures,
      chatThreadId: zeroWorkflowTriggers.chatThreadId,
      agentId: zeroWorkflowTriggers.agentId,
    })
    .from(zeroWorkflowTriggers)
    .innerJoin(
      zeroWorkflows,
      eq(zeroWorkflowTriggers.workflowId, zeroWorkflows.id),
    )
    .where(
      and(
        eq(zeroWorkflowTriggers.orgId, fixture.orgId),
        eq(zeroWorkflowTriggers.chatThreadId, fixture.threadId),
        eq(zeroWorkflowTriggers.kind, "event"),
      ),
    )
    .limit(1);
  return row;
}

describe("zero goals", () => {
  it("rejects goal writes while the feature switch is disabled", async () => {
    const fixture = await seedGoalApiFixture({ featureEnabled: false });

    const response = await accept(
      goalsClient().create({
        headers: headers(fixture, ["goal:write"]),
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

  it("creates, reads, blocks, resumes, completes, and lists goal workflows in the registry", async () => {
    const fixture = await seedGoalApiFixture({ featureEnabled: true });

    const created = await accept(
      goalsClient().create({
        headers: headers(fixture),
        body: { objective: "ship goal workflows", tokenBudget: 10_000 },
      }),
      [201],
    );
    expect(created.body).toStrictEqual({
      active: true,
      objective: "ship goal workflows",
      status: "active",
      tokenBudget: 10_000,
    });

    const goalRows = await loadGoalRows(fixture);
    expect(goalRows).toMatchObject({
      workflowType: "goal",
      active: true,
      visibility: "private",
      preference: {
        version: 1,
        objective: "ship goal workflows",
        tokenBudget: 10_000,
      },
      kind: "event",
      eventType: "thread-idle",
      scheduleType: null,
      nextRunAt: null,
      enabled: true,
      chatThreadId: fixture.threadId,
      agentId: fixture.agentId,
    });

    const duplicate = await accept(
      goalsClient().create({
        headers: headers(fixture),
        body: { objective: "try another goal" },
      }),
      [409],
    );
    expect(duplicate.body.error.message).toContain(
      "Complete the existing goal",
    );

    const read = await accept(
      goalsClient().get({ headers: headers(fixture, ["goal:read"]) }),
      [200],
    );
    expect(read.body).toStrictEqual(created.body);

    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const workflows = await accept(
      workflowsClient().list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const workflowNames = workflows.body.map((workflow) => {
      return workflow.name;
    });
    expect(workflowNames).toContain(goalRows?.workflowName);

    const blocked = await accept(
      goalsClient().block({ headers: headers(fixture) }),
      [200],
    );
    expect(blocked.body).toMatchObject({
      active: true,
      objective: "ship goal workflows",
      status: "blocked",
    });

    const db = store.set(writeDb$);
    await db
      .update(zeroWorkflowTriggers)
      .set({ consecutiveFailures: 2 })
      .where(eq(zeroWorkflowTriggers.id, goalRows!.triggerId));

    const resumed = await accept(
      goalsClient().resume({ headers: headers(fixture) }),
      [200],
    );
    expect(resumed.body).toMatchObject({
      active: true,
      objective: "ship goal workflows",
      status: "active",
    });
    const resumedRows = await loadGoalRows(fixture);
    expect(resumedRows?.consecutiveFailures).toBe(0);

    const completed = await accept(
      goalsClient().complete({ headers: headers(fixture) }),
      [200],
    );
    expect(completed.body).toMatchObject({
      active: false,
      objective: "ship goal workflows",
      status: "complete",
    });

    const nextGoal = await accept(
      goalsClient().create({
        headers: headers(fixture),
        body: { objective: "start next goal" },
      }),
      [201],
    );
    expect(nextGoal.body).toMatchObject({
      active: true,
      objective: "start next goal",
      status: "active",
    });
  });

  it("provisions a chat thread when the current run has none", async () => {
    const fixture = await seedGoalApiFixture({ featureEnabled: true });
    // A run from a non-chat trigger (slack/telegram/email) has no chat thread.
    const threadlessRun = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: fixture.agentId,
        triggerSource: "slack",
        status: "running",
      },
      context.signal,
    );

    const created = await accept(
      goalsClient().create({
        headers: headers({ ...fixture, runId: threadlessRun.runId }),
        body: { objective: "merge the release PR into main" },
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      active: true,
      objective: "merge the release PR into main",
      status: "active",
    });

    const db = store.set(writeDb$);
    const triggers = await db
      .select({
        chatThreadId: zeroWorkflowTriggers.chatThreadId,
        agentId: zeroWorkflowTriggers.agentId,
        eventType: zeroWorkflowTriggers.eventType,
      })
      .from(zeroWorkflowTriggers)
      .innerJoin(
        zeroWorkflows,
        eq(zeroWorkflowTriggers.workflowId, zeroWorkflows.id),
      )
      .where(
        and(
          eq(zeroWorkflowTriggers.orgId, fixture.orgId),
          eq(zeroWorkflows.type, "goal"),
          eq(zeroWorkflowTriggers.kind, "event"),
        ),
      );
    expect(triggers).toHaveLength(1);
    const trigger = triggers[0]!;
    expect(trigger.eventType).toBe("thread-idle");
    expect(trigger.agentId).toBe(fixture.agentId);
    // The goal is bound to a freshly provisioned thread, not the seeded one.
    expect(trigger.chatThreadId).not.toBeNull();
    expect(trigger.chatThreadId).not.toBe(fixture.threadId);

    const [thread] = await db
      .select({
        agentComposeId: chatThreads.agentComposeId,
        title: chatThreads.title,
      })
      .from(chatThreads)
      .where(eq(chatThreads.id, trigger.chatThreadId!))
      .limit(1);
    expect(thread).toMatchObject({
      agentComposeId: fixture.agentId,
      title: "merge the release PR into main",
    });
  });
});
