import { randomUUID } from "node:crypto";

import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { userCache } from "@vm0/db/schema/user-cache";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  zeroWorkflowTriggers,
  zeroWorkflows,
  type ZeroWorkflowScheduleType,
} from "@vm0/db/schema/zero-workflow";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import {
  resetSecretKmsClientForTests,
  setSecretKmsClientForTests,
} from "../../services/crypto.utils";
import { writeDb$, type Db } from "../../external/db";
import { dispatchRunCallbacks$ } from "../../services/agent-run-callback.service";
import { executeDueWorkflowTriggers$ } from "../../services/zero-workflow-trigger-poller.service";
import { handleWorkflowTriggerInternalCallback } from "../../services/zero-workflow-trigger-run-callback.service";
import {
  disableTriggersForDetachedAgent,
  testRunWorkflowTrigger$,
} from "../../services/zero-workflow-trigger.service";
import {
  deleteWorkflowsForFixture$,
  seedAgentForInstructions$,
  seedWorkflowsFixture$,
  type WorkflowsFixture,
} from "./helpers/zero-workflows";
import { fakeKmsClient } from "./helpers/fake-kms-client";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const track = createFixtureTracker<WorkflowsFixture>((fixture) => {
  return store.set(deleteWorkflowsForFixture$, fixture, context.signal);
});

const WORKFLOW_NAME = "scheduler-workflow";

afterEach(() => {
  resetSecretKmsClientForTests();
});

interface Scenario {
  readonly fixture: WorkflowsFixture;
  readonly agentId: string;
  readonly workflowId: string;
}

async function setup(): Promise<Scenario> {
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  mockEnv("CRON_SECRET", "test-cron-secret");
  context.mocks.s3.send.mockResolvedValue({});
  setSecretKmsClientForTests(fakeKmsClient().client);

  const fixture = await store.set(
    seedWorkflowsFixture$,
    undefined,
    context.signal,
  );
  const db = store.set(writeDb$);
  await db
    .insert(orgMembersCache)
    .values({ userId: fixture.userId, orgId: fixture.orgId, role: "member" });
  await db
    .insert(orgMembersMetadata)
    .values({ userId: fixture.userId, orgId: fixture.orgId, timezone: null });
  await db
    .insert(userCache)
    .values({ userId: fixture.userId, email: `${fixture.userId}@example.com` });

  const { agentId } = await store.set(
    seedAgentForInstructions$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "scheduler-agent",
      workflowNames: [WORKFLOW_NAME],
      composeContent: {
        version: "1.0",
        agents: {
          "scheduler-agent": {
            framework: "claude-code",
            environment: { ANTHROPIC_API_KEY: "test-key" },
          },
        },
      },
    },
    context.signal,
  );
  const [workflow] = await db
    .select({ id: zeroWorkflows.id })
    .from(zeroWorkflows)
    .where(
      and(
        eq(zeroWorkflows.orgId, fixture.orgId),
        eq(zeroWorkflows.name, WORKFLOW_NAME),
      ),
    );
  mocks.clerk.session(fixture.userId, fixture.orgId);
  await track(Promise.resolve(fixture));
  return { fixture, agentId, workflowId: workflow!.id };
}

async function seedTrigger(
  scenario: Scenario,
  opts: {
    readonly scheduleType: ZeroWorkflowScheduleType;
    readonly cronExpression?: string;
    readonly intervalSeconds?: number;
    readonly nextRunAt: Date | null;
    readonly enabled?: boolean;
    readonly consecutiveFailures?: number;
    readonly lastRunId?: string;
  },
): Promise<{ triggerId: string; threadId: string }> {
  const db = store.set(writeDb$);
  const [thread] = await db
    .insert(chatThreads)
    .values({
      userId: scenario.fixture.userId,
      agentComposeId: scenario.agentId,
      title: "trigger thread",
    })
    .returning({ id: chatThreads.id });
  const [trigger] = await db
    .insert(zeroWorkflowTriggers)
    .values({
      orgId: scenario.fixture.orgId,
      workflowId: scenario.workflowId,
      agentId: scenario.agentId,
      ownerUserId: scenario.fixture.userId,
      scheduleType: opts.scheduleType,
      cronExpression: opts.cronExpression ?? null,
      intervalSeconds: opts.intervalSeconds ?? null,
      atTime: opts.scheduleType === "once" ? opts.nextRunAt : null,
      timezone: "UTC",
      enabled: opts.enabled ?? true,
      chatThreadId: thread!.id,
      nextRunAt: opts.nextRunAt,
      consecutiveFailures: opts.consecutiveFailures ?? 0,
      lastRunId: opts.lastRunId ?? null,
    })
    .returning({ id: zeroWorkflowTriggers.id });
  return { triggerId: trigger!.id, threadId: thread!.id };
}

async function enableGoalFeature(scenario: Scenario): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(userFeatureSwitches).values({
    orgId: scenario.fixture.orgId,
    userId: scenario.fixture.userId,
    switches: { [FeatureSwitchKey.GoalWorkflows]: true },
  });
}

async function seedThreadRun(
  scenario: Scenario,
  opts: {
    readonly status:
      | "queued"
      | "pending"
      | "running"
      | "completed"
      | "failed"
      | "timeout"
      | "cancelled";
    readonly threadId?: string;
    readonly prompt?: string;
    readonly result?: Record<string, unknown> | null;
  },
): Promise<{ runId: string; threadId: string; sessionId: string }> {
  const db = store.set(writeDb$);
  const threadId =
    opts.threadId ??
    (
      await db
        .insert(chatThreads)
        .values({
          userId: scenario.fixture.userId,
          agentComposeId: scenario.agentId,
          title: "goal thread",
        })
        .returning({ id: chatThreads.id })
    )[0]!.id;
  const [compose] = await db
    .select({ headVersionId: agentComposes.headVersionId })
    .from(agentComposes)
    .where(eq(agentComposes.id, scenario.agentId))
    .limit(1);
  if (!compose?.headVersionId) {
    throw new Error("Expected seeded agent to have a head compose version");
  }
  const [session] = await db
    .insert(agentSessions)
    .values({
      userId: scenario.fixture.userId,
      orgId: scenario.fixture.orgId,
      agentComposeId: scenario.agentId,
    })
    .returning({ id: agentSessions.id });
  if (!session) {
    throw new Error("Failed to seed agent session");
  }
  const [run] = await db
    .insert(agentRuns)
    .values({
      userId: scenario.fixture.userId,
      orgId: scenario.fixture.orgId,
      agentComposeVersionId: compose.headVersionId,
      sessionId: session.id,
      status: opts.status,
      prompt: opts.prompt ?? "goal terminal run",
      result: opts.result ?? { agentSessionId: session.id },
      completedAt: ["completed", "failed", "timeout", "cancelled"].includes(
        opts.status,
      )
        ? nowDate()
        : null,
    })
    .returning({ id: agentRuns.id });
  if (!run) {
    throw new Error("Failed to seed agent run");
  }
  await db.insert(zeroRuns).values({
    id: run.id,
    triggerSource: "web",
    chatThreadId: threadId,
  });
  return { runId: run.id, threadId, sessionId: session.id };
}

async function seedGoalTrigger(
  scenario: Scenario,
  args: {
    readonly threadId: string;
    readonly consecutiveFailures?: number;
    readonly enabled?: boolean;
  },
): Promise<{ workflowId: string; triggerId: string }> {
  const db = store.set(writeDb$);
  const [workflow] = await db
    .insert(zeroWorkflows)
    .values({
      orgId: scenario.fixture.orgId,
      name: `goal-${randomUUID().slice(0, 8)}`,
      visibility: "private",
      type: "goal",
      active: true,
      preference: { version: 1, objective: "Ship the goal workflow" },
      ownerUserId: scenario.fixture.userId,
      displayName: "Goal",
      createdBy: scenario.fixture.userId,
    })
    .returning({ id: zeroWorkflows.id });
  if (!workflow) {
    throw new Error("Failed to seed goal workflow");
  }
  const [trigger] = await db
    .insert(zeroWorkflowTriggers)
    .values({
      orgId: scenario.fixture.orgId,
      workflowId: workflow.id,
      agentId: scenario.agentId,
      ownerUserId: scenario.fixture.userId,
      kind: "event",
      eventType: "thread-idle",
      scheduleType: null,
      cronExpression: null,
      intervalSeconds: null,
      atTime: null,
      enabled: args.enabled ?? true,
      chatThreadId: args.threadId,
      nextRunAt: null,
      consecutiveFailures: args.consecutiveFailures ?? 0,
    })
    .returning({ id: zeroWorkflowTriggers.id });
  if (!trigger) {
    throw new Error("Failed to seed goal trigger");
  }
  return { workflowId: workflow.id, triggerId: trigger.id };
}

async function loadTrigger(db: Db, triggerId: string) {
  const [trigger] = await db
    .select()
    .from(zeroWorkflowTriggers)
    .where(eq(zeroWorkflowTriggers.id, triggerId))
    .limit(1);
  return trigger;
}

function pastDate(): Date {
  return new Date(now() - 3_600_000);
}

describe("zero workflow trigger scheduler", () => {
  it("fires a due cron trigger: creates a run, posts to the thread, sets last_run_id", async () => {
    const scenario = await setup();
    const { triggerId, threadId } = await seedTrigger(scenario, {
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
      nextRunAt: pastDate(),
    });

    const result = await store.set(executeDueWorkflowTriggers$, context.signal);
    expect(result.executed).toBe(1);

    const db = store.set(writeDb$);
    const runs = await db
      .select({ id: zeroRuns.id, triggerSource: zeroRuns.triggerSource })
      .from(zeroRuns)
      .where(eq(zeroRuns.workflowTriggerId, triggerId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.triggerSource).toBe("workflow-schedule");

    const trigger = await loadTrigger(db, triggerId);
    expect(trigger?.nextRunAt).toBeNull();
    expect(trigger?.lastRunId).toBe(runs[0]?.id);

    const messages = await db
      .select({ role: chatMessages.role, content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.chatThreadId, threadId));
    expect(
      messages.some((m) => {
        return m.role === "user" && m.content === `/${WORKFLOW_NAME}`;
      }),
    ).toBeTruthy();

    const callbacks = await db
      .select({ internalKind: agentRunCallbacks.internalKind })
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, runs[0]!.id));
    const kinds = callbacks.map((c) => {
      return c.internalKind;
    });
    expect(kinds).toContain("workflow-trigger:cron");
    expect(kinds).toContain("chat");
  });

  it("disables a one-time trigger when it fires", async () => {
    const scenario = await setup();
    const { triggerId } = await seedTrigger(scenario, {
      scheduleType: "once",
      nextRunAt: pastDate(),
    });

    const result = await store.set(executeDueWorkflowTriggers$, context.signal);
    expect(result.executed).toBe(1);

    const trigger = await loadTrigger(store.set(writeDb$), triggerId);
    expect(trigger?.enabled).toBeFalsy();
    expect(trigger?.nextRunAt).toBeNull();
  });

  it("skips a trigger whose previous run is still active", async () => {
    const scenario = await setup();
    const db = store.set(writeDb$);
    const [session] = await db
      .insert(agentSessions)
      .values({
        userId: scenario.fixture.userId,
        orgId: scenario.fixture.orgId,
        agentComposeId: scenario.agentId,
      })
      .returning({ id: agentSessions.id });
    const [activeRun] = await db
      .insert(agentRuns)
      .values({
        userId: scenario.fixture.userId,
        orgId: scenario.fixture.orgId,
        sessionId: session!.id,
        status: "running",
        prompt: "active",
      })
      .returning({ id: agentRuns.id });
    const due = pastDate();
    const { triggerId } = await seedTrigger(scenario, {
      scheduleType: "loop",
      intervalSeconds: 300,
      nextRunAt: due,
      lastRunId: activeRun!.id,
    });

    const result = await store.set(executeDueWorkflowTriggers$, context.signal);
    expect(result.executed).toBe(0);

    const trigger = await loadTrigger(db, triggerId);
    expect(trigger?.nextRunAt?.getTime()).toBe(due.getTime());
  });

  it("advances a cron trigger on the completion callback", async () => {
    const scenario = await setup();
    const { triggerId } = await seedTrigger(scenario, {
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
      nextRunAt: null,
    });

    const db = store.set(writeDb$);
    const result = await handleWorkflowTriggerInternalCallback(db, {
      kind: "workflow-trigger:cron",
      callback: {
        runId: randomUUID(),
        status: "completed",
        payload: { triggerId, timezone: "UTC", cronExpression: "0 9 * * *" },
      },
    });
    expect(result.success).toBeTruthy();

    const trigger = await loadTrigger(db, triggerId);
    expect(trigger?.nextRunAt).not.toBeNull();
    expect(trigger?.consecutiveFailures).toBe(0);
  });

  it("reschedules a loop trigger by its interval on completion", async () => {
    const scenario = await setup();
    const { triggerId } = await seedTrigger(scenario, {
      scheduleType: "loop",
      intervalSeconds: 300,
      nextRunAt: null,
    });

    const db = store.set(writeDb$);
    const before = now();
    await handleWorkflowTriggerInternalCallback(db, {
      kind: "workflow-trigger:loop",
      callback: {
        runId: randomUUID(),
        status: "completed",
        payload: { triggerId },
      },
    });

    const trigger = await loadTrigger(db, triggerId);
    expect(trigger?.nextRunAt).not.toBeNull();
    expect(trigger?.nextRunAt!.getTime()).toBeGreaterThanOrEqual(
      before + 290_000,
    );
  });

  it("auto-disables a trigger after three consecutive failures", async () => {
    const scenario = await setup();
    const { triggerId } = await seedTrigger(scenario, {
      scheduleType: "loop",
      intervalSeconds: 300,
      nextRunAt: null,
      consecutiveFailures: 2,
    });

    const db = store.set(writeDb$);
    await handleWorkflowTriggerInternalCallback(db, {
      kind: "workflow-trigger:loop",
      callback: {
        runId: randomUUID(),
        status: "failed",
        payload: { triggerId },
      },
    });

    const trigger = await loadTrigger(db, triggerId);
    expect(trigger?.consecutiveFailures).toBe(3);
    expect(trigger?.enabled).toBeFalsy();
    expect(trigger?.nextRunAt).toBeNull();
  });

  it("test-run fires a run into the thread without advancing the schedule", async () => {
    const scenario = await setup();
    const future = new Date(now() + 3_600_000);
    const { triggerId, threadId } = await seedTrigger(scenario, {
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
      nextRunAt: future,
    });

    const result = await store.set(
      testRunWorkflowTrigger$,
      {
        orgId: scenario.fixture.orgId,
        member: { userId: scenario.fixture.userId, role: "member" },
        triggerId,
      },
      context.signal,
    );
    expect(result.kind).toBe("ok");

    const db = store.set(writeDb$);
    const runs = await db
      .select({ id: zeroRuns.id, triggerSource: zeroRuns.triggerSource })
      .from(zeroRuns)
      .where(eq(zeroRuns.workflowTriggerId, triggerId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.triggerSource).toBe("workflow-schedule");

    // A test run must not advance or claim the schedule.
    const trigger = await loadTrigger(db, triggerId);
    expect(trigger?.nextRunAt?.getTime()).toBe(future.getTime());
    expect(trigger?.lastRunId).toBeNull();

    // Only the chat callback is attached — no recurrence callback.
    const callbacks = await db
      .select({ internalKind: agentRunCallbacks.internalKind })
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, runs[0]!.id));
    const kinds = callbacks.map((c) => {
      return c.internalKind;
    });
    expect(kinds).toContain("chat");
    expect(kinds).not.toContain("workflow-trigger:cron");

    const messages = await db
      .select({ content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.chatThreadId, threadId));
    expect(
      messages.some((m) => {
        return m.content === `/${WORKFLOW_NAME}`;
      }),
    ).toBeTruthy();
  });

  it("continues an active goal from the terminal callback when the thread is idle", async () => {
    const scenario = await setup();
    await enableGoalFeature(scenario);
    const terminal = await seedThreadRun(scenario, { status: "completed" });
    const { triggerId } = await seedGoalTrigger(scenario, {
      threadId: terminal.threadId,
      consecutiveFailures: 2,
    });

    const db = store.set(writeDb$);
    await store.set(
      dispatchRunCallbacks$,
      { db, runId: terminal.runId, status: "completed" },
      context.signal,
    );

    const runs = await db
      .select({
        id: zeroRuns.id,
        triggerSource: zeroRuns.triggerSource,
        prompt: agentRuns.prompt,
        continuedFromSessionId: agentRuns.continuedFromSessionId,
      })
      .from(zeroRuns)
      .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
      .where(eq(zeroRuns.workflowTriggerId, triggerId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      triggerSource: "workflow-event",
      prompt: "/goal",
      continuedFromSessionId: terminal.sessionId,
    });

    const callbacks = await db
      .select({ internalKind: agentRunCallbacks.internalKind })
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, runs[0]!.id));
    expect(
      callbacks.map((callback) => {
        return callback.internalKind;
      }),
    ).toStrictEqual(["chat"]);

    const trigger = await loadTrigger(db, triggerId);
    expect(trigger?.lastRunId).toBe(runs[0]?.id);
    expect(trigger?.lastRunAt).not.toBeNull();
    expect(trigger?.consecutiveFailures).toBe(0);

    const messages = await db
      .select({ content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.chatThreadId, terminal.threadId));
    expect(
      messages.some((message) => {
        return message.content === "/goal";
      }),
    ).toBeTruthy();
  });

  it("does not continue a goal when another run is already queued on the thread", async () => {
    const scenario = await setup();
    await enableGoalFeature(scenario);
    const terminal = await seedThreadRun(scenario, { status: "completed" });
    const { triggerId } = await seedGoalTrigger(scenario, {
      threadId: terminal.threadId,
    });
    await seedThreadRun(scenario, {
      status: "queued",
      threadId: terminal.threadId,
      prompt: "user queued turn",
    });

    const db = store.set(writeDb$);
    await store.set(
      dispatchRunCallbacks$,
      { db, runId: terminal.runId, status: "completed" },
      context.signal,
    );

    const runs = await db
      .select({ id: zeroRuns.id })
      .from(zeroRuns)
      .where(eq(zeroRuns.workflowTriggerId, triggerId));
    expect(runs).toHaveLength(0);
  });

  it("auto-stops a goal after three consecutive failed goal turns", async () => {
    const scenario = await setup();
    await enableGoalFeature(scenario);
    const terminal = await seedThreadRun(scenario, { status: "failed" });
    const { triggerId } = await seedGoalTrigger(scenario, {
      threadId: terminal.threadId,
      consecutiveFailures: 2,
    });

    const db = store.set(writeDb$);
    await store.set(
      dispatchRunCallbacks$,
      {
        db,
        runId: terminal.runId,
        status: "failed",
        error: "run failed",
      },
      context.signal,
    );

    const trigger = await loadTrigger(db, triggerId);
    expect(trigger?.enabled).toBeFalsy();
    expect(trigger?.consecutiveFailures).toBe(3);

    const runs = await db
      .select({ id: zeroRuns.id })
      .from(zeroRuns)
      .where(eq(zeroRuns.workflowTriggerId, triggerId));
    expect(runs).toHaveLength(0);
  });

  it("pauses a goal when the user cancels the terminal run", async () => {
    const scenario = await setup();
    await enableGoalFeature(scenario);
    const terminal = await seedThreadRun(scenario, { status: "cancelled" });
    const { triggerId } = await seedGoalTrigger(scenario, {
      threadId: terminal.threadId,
    });

    const db = store.set(writeDb$);
    await store.set(
      dispatchRunCallbacks$,
      {
        db,
        runId: terminal.runId,
        status: "failed",
        error: "Run cancelled",
      },
      context.signal,
    );

    const trigger = await loadTrigger(db, triggerId);
    expect(trigger?.enabled).toBeFalsy();
    expect(trigger?.consecutiveFailures).toBe(0);
  });

  it("disables triggers when the workflow is detached from the agent", async () => {
    const scenario = await setup();
    const { triggerId } = await seedTrigger(scenario, {
      scheduleType: "loop",
      intervalSeconds: 300,
      nextRunAt: pastDate(),
    });

    const db = store.set(writeDb$);
    await disableTriggersForDetachedAgent(db, {
      orgId: scenario.fixture.orgId,
      workflowId: scenario.workflowId,
      agentId: scenario.agentId,
    });

    const trigger = await loadTrigger(db, triggerId);
    expect(trigger?.enabled).toBeFalsy();
    expect(trigger?.nextRunAt).toBeNull();
  });
});
