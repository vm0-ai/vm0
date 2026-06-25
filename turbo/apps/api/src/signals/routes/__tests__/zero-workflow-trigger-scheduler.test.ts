import { randomUUID } from "node:crypto";

import type { UnattendedTriggerPermissionPolicy } from "@vm0/api-contracts/contracts/zero-workflows";
import { networkPoliciesSchema } from "@vm0/connectors/firewall-types";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { connectors } from "@vm0/db/schema/connector";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { secrets } from "@vm0/db/schema/secret";
import { userCache } from "@vm0/db/schema/user-cache";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { userPermissionGrants } from "@vm0/db/schema/user-permission-grant";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  zeroWorkflowTriggers,
  zeroWorkflows,
  type ZeroWorkflowScheduleType,
} from "@vm0/db/schema/zero-workflow";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import {
  encryptStoredSecretValue,
  resetSecretKmsClientForTests,
  setSecretKmsClientForTests,
} from "../../services/crypto.utils";
import { writeDb$, type Db } from "../../external/db";
import { executeDueWorkflowTriggers$ } from "../../services/zero-workflow-trigger-poller.service";
import { handleWorkflowTriggerInternalCallback } from "../../services/zero-workflow-trigger-run-callback.service";
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
    readonly unattendedPermissionPolicy?: UnattendedTriggerPermissionPolicy | null;
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
      unattendedPermissionPolicy: opts.unattendedPermissionPolicy ?? null,
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

async function runNetworkPolicies(db: Db, runId: string) {
  const [job] = await db
    .select({ ctx: runnerJobQueue.executionContext })
    .from(runnerJobQueue)
    .where(eq(runnerJobQueue.runId, runId))
    .limit(1);
  if (!job) {
    throw new Error("Expected a runner job for the trigger run");
  }
  return z
    .object({ networkPolicies: networkPoliciesSchema.optional() })
    .parse(job.ctx).networkPolicies;
}

async function runEnvironment(db: Db, runId: string) {
  const [job] = await db
    .select({ ctx: runnerJobQueue.executionContext })
    .from(runnerJobQueue)
    .where(eq(runnerJobQueue.runId, runId))
    .limit(1);
  if (!job) {
    throw new Error("Expected a runner job for the trigger run");
  }
  return z
    .object({ environment: z.record(z.string(), z.string()) })
    .parse(job.ctx).environment;
}

async function runIdForTrigger(db: Db, triggerId: string): Promise<string> {
  const [run] = await db
    .select({ id: zeroRuns.id })
    .from(zeroRuns)
    .where(eq(zeroRuns.workflowTriggerId, triggerId))
    .limit(1);
  if (!run) {
    throw new Error("Expected a run for the trigger");
  }
  return run.id;
}

describe("zero workflow trigger scheduler", () => {
  it("isolates trigger-run permissions: uses the trigger policy, never agent grants", async () => {
    const scenario = await setup();
    const db = store.set(writeDb$);

    // A real Gmail connection so the gmail firewall is built into the manifest.
    await db.insert(connectors).values({
      orgId: scenario.fixture.orgId,
      userId: scenario.fixture.userId,
      type: "gmail",
      authMethod: "oauth",
      externalEmail: "trigger-user@example.com",
      tokenExpiresAt: new Date(now() + 60 * 60 * 1000),
      oauthScopes: JSON.stringify([
        "https://www.googleapis.com/auth/gmail.modify",
      ]),
    });
    await db.insert(secrets).values({
      orgId: scenario.fixture.orgId,
      userId: scenario.fixture.userId,
      name: "GMAIL_ACCESS_TOKEN",
      encryptedValue: await encryptStoredSecretValue("gmail-access-token"),
      type: "connector",
    });
    // Enable Gmail for the agent so it surfaces in the resolved network policies.
    await db.insert(userConnectors).values({
      orgId: scenario.fixture.orgId,
      userId: scenario.fixture.userId,
      agentId: scenario.agentId,
      connectorType: "gmail",
    });
    // An agent/user grant that an isolated trigger run must NOT inherit.
    await db.insert(userPermissionGrants).values({
      orgId: scenario.fixture.orgId,
      userId: scenario.fixture.userId,
      agentId: scenario.agentId,
      connectorRef: "gmail",
      permission: "messages.write",
      action: "allow",
    });

    // The trigger grants a different permission than the agent grant above.
    const trigger = await seedTrigger(scenario, {
      scheduleType: "loop",
      intervalSeconds: 60,
      nextRunAt: pastDate(),
      unattendedPermissionPolicy: {
        gmail: { policies: { "labels.write": "allow" } },
      },
    });

    const result = await store.set(executeDueWorkflowTriggers$, context.signal);
    expect(result.executed).toBe(1);

    const policies = await runNetworkPolicies(
      db,
      await runIdForTrigger(db, trigger.triggerId),
    );
    // The trigger's own policy is honored.
    expect(policies?.gmail?.allow ?? []).toContain("labels.write");
    // The agent grant is NOT inherited by the unattended run.
    expect(policies?.gmail?.allow ?? []).not.toContain("messages.write");
    // It resolves to deny, and no permission is left as ask in an unattended run.
    expect(policies?.gmail?.deny ?? []).toContain("messages.write");
    expect(policies?.gmail?.ask ?? []).toHaveLength(0);
  });

  it("exposes the trigger and workflow ids to the run environment", async () => {
    const scenario = await setup();
    const trigger = await seedTrigger(scenario, {
      scheduleType: "loop",
      intervalSeconds: 60,
      nextRunAt: pastDate(),
    });

    const result = await store.set(executeDueWorkflowTriggers$, context.signal);
    expect(result.executed).toBe(1);

    const db = store.set(writeDb$);
    const environment = await runEnvironment(
      db,
      await runIdForTrigger(db, trigger.triggerId),
    );
    expect(environment.ZERO_WORKFLOW_TRIGGER_ID).toBe(trigger.triggerId);
    expect(environment.ZERO_WORKFLOW_ID).toBe(scenario.workflowId);
  });

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

  it("cascade-deletes a workflow's triggers when the workflow is removed", async () => {
    const scenario = await setup();
    const { triggerId } = await seedTrigger(scenario, {
      scheduleType: "loop",
      intervalSeconds: 300,
      nextRunAt: pastDate(),
    });

    const db = store.set(writeDb$);
    // Under the hard 1:N model a workflow belongs to exactly one agent; removing
    // the workflow cascade-deletes its triggers (FK onDelete: cascade).
    await db
      .delete(zeroWorkflows)
      .where(
        and(
          eq(zeroWorkflows.orgId, scenario.fixture.orgId),
          eq(zeroWorkflows.id, scenario.workflowId),
        ),
      );

    const trigger = await loadTrigger(db, triggerId);
    expect(trigger).toBeUndefined();
  });
});
