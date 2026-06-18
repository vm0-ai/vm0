import { randomUUID } from "node:crypto";

import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { userCache } from "@vm0/db/schema/user-cache";
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
import { now } from "../../../lib/time";
import {
  resetSecretKmsClientForTests,
  setSecretKmsClientForTests,
} from "../../services/crypto.utils";
import { writeDb$, type Db } from "../../external/db";
import { executeDueWorkflowTriggers$ } from "../../services/zero-workflow-trigger-poller.service";
import { handleWorkflowTriggerInternalCallback } from "../../services/zero-workflow-trigger-run-callback.service";
import { disableTriggersForDetachedAgent } from "../../services/zero-workflow-trigger.service";
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
