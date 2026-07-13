import { createHash, randomUUID } from "node:crypto";

import { zeroWorkflowTriggersContract } from "@vm0/api-contracts/contracts/zero-workflows";
import {
  zeroAgentsByIdContract,
  zeroAgentsMainContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import type { ApiTestUser } from "./helpers/api-bdd";
import { mockGmailConnectorOAuth } from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const wf = createWorkflowsBddApi(context);
const runsApi = createRunsApi(context);
const webhooksApi = createWebhookCallbackApi(context);

const WORKFLOW_NAME = "scheduler-workflow";
const CRON_EXECUTE_WORKFLOW_TRIGGERS_ROUTE =
  "/api/cron/execute-workflow-triggers";
const CRON_SECRET = "test-cron-secret";

interface Scenario {
  readonly actor: ApiTestUser;
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly workflowId: string;
  readonly runnerGroup: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function triggersClient() {
  return setupApp({ context })(zeroWorkflowTriggersContract);
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function expectOk(response: Response, operation: string): void {
  if (response.ok) {
    return;
  }
  throw new Error(`${operation} failed with ${response.status}`);
}

async function setup(
  options: { readonly timezone?: string } = {},
): Promise<Scenario> {
  const runnerGroup = runsApi.configureRunnerGroup();
  mockEnv("CRON_SECRET", CRON_SECRET);
  const { actor } = await wf.setupWorkflowOrg({ timezone: options.timezone });
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped workflow actor");
  }
  const agent = await wf.createAgent(actor, {
    displayName: "Scheduler Agent",
  });
  const workflowId = await wf.createWorkflow(actor, {
    agentId: agent.agentId,
    name: WORKFLOW_NAME,
  });
  mocks.clerk.session(actor.userId, actor.orgId);
  context.mocks.s3.send.mockResolvedValue({});
  return {
    actor,
    orgId: actor.orgId,
    userId: actor.userId,
    agentId: agent.agentId,
    workflowId,
    runnerGroup,
  };
}

interface CreatedTrigger {
  readonly triggerId: string;
  readonly threadId: string;
  readonly nextRunAt: string | null;
}

/** Loop triggers are due immediately on creation. */
async function createDueLoopTrigger(
  scenario: Scenario,
  intervalSeconds: number,
): Promise<CreatedTrigger> {
  const created = await accept(
    triggersClient().create({
      headers: authHeaders(),
      params: { workflowId: scenario.workflowId },
      body: { schedule: { type: "loop", intervalSeconds } },
    }),
    [201],
  );
  if (!created.body.chatThreadId) {
    throw new Error("Expected the trigger to bind a chat thread");
  }
  return {
    triggerId: created.body.id,
    threadId: created.body.chatThreadId,
    nextRunAt: created.body.nextRunAt,
  };
}

async function disableTrigger(triggerId: string): Promise<void> {
  await accept(
    triggersClient().disable({
      headers: authHeaders(),
      params: { id: triggerId },
    }),
    [200],
  );
}

async function executeDueWorkflowTriggers(): Promise<void> {
  const response = await createApp({ signal: context.signal }).request(
    CRON_EXECUTE_WORKFLOW_TRIGGERS_ROUTE,
    { headers: { authorization: `Bearer ${CRON_SECRET}` } },
  );
  await expectOk(response, "execute workflow triggers cron");
  const body = await readJson<{ readonly success: boolean }>(response);
  expect(body.success).toBeTruthy();
}

interface WorkflowRunMessage {
  readonly runId: string;
  readonly triggerSource: string | undefined;
  readonly triggerBrief: string | null | undefined;
}

/**
 * Workflow-trigger fires post a `/workflow-name` user message with the run id
 * into the bound thread; this is the public read for "runs of this trigger".
 */
async function workflowRunMessages(
  threadId: string,
): Promise<readonly WorkflowRunMessage[]> {
  const messages = await wf.readThreadMessages(threadId);
  return messages.flatMap((message) => {
    if (
      message.role !== "user" ||
      message.content !== `/${WORKFLOW_NAME}` ||
      !message.runId
    ) {
      return [];
    }
    return [
      {
        runId: message.runId,
        triggerSource: message.triggerSource,
        triggerBrief: message.workflowSnapshot?.triggerBrief,
      },
    ];
  });
}

async function onlyWorkflowRunMessage(
  threadId: string,
): Promise<WorkflowRunMessage> {
  const messages = await workflowRunMessages(threadId);
  expect(messages).toHaveLength(1);
  return messages[0]!;
}

function friendlyTriggeredAtPattern(timezone: string): string {
  return String.raw`Triggered at \d{1,2}:\d{2} [AP]M, [A-Z][a-z]{2} \d{1,2}, \d{4} \(${timezone.replace(
    /\//gu,
    String.raw`\/`,
  )}\)`;
}

async function completeRunThroughSandbox(
  scenario: Scenario,
  runId: string,
  exitCode: number,
): Promise<void> {
  await runsApi.heartbeatRunner(scenario.runnerGroup);
  const claim = await runsApi.claimRunnerJob(runId);
  const sandboxHeaders = { authorization: `Bearer ${claim.sandboxToken}` };
  await webhooksApi.requestAgentCheckpoint(
    {
      runId,
      cliAgentType: "claude-code",
      cliAgentSessionId: `workflow-trigger-cli-${runId}`,
      cliAgentSessionHistoryHash: createHash("sha256")
        .update(`workflow trigger history ${runId}`)
        .digest("hex"),
    },
    sandboxHeaders,
    [200],
  );
  await webhooksApi.requestAgentComplete(
    { runId, exitCode },
    sandboxHeaders,
    [200],
  );
}

async function deleteWorkflowViaApi(scenario: Scenario): Promise<void> {
  const response = await createApp({ signal: context.signal }).request(
    `/api/zero/workflows/${scenario.workflowId}`,
    {
      method: "DELETE",
      headers: { authorization: "Bearer clerk-session" },
    },
  );
  await expectOk(response, "delete workflow");
}

describe("zero workflow trigger scheduler", () => {
  it("uses agent connector authorization and permission grants for trigger runs", async () => {
    const scenario = await setup();

    // A real Gmail connection plus the public agent-connector and permission
    // grant routes, so the gmail firewall is built into the manifest.
    mockGmailConnectorOAuth({ email: "trigger-user@example.com" });
    await wf.connectConnector(scenario.actor, "gmail");
    await accept(
      setupApp({ context })(zeroUserConnectorsContract).update({
        headers: authHeaders(),
        params: { id: scenario.agentId },
        body: { enabledTypes: ["gmail"] },
      }),
      [200],
    );
    await runsApi.applyUserPermissionGrant(scenario.actor, {
      agentId: scenario.agentId,
      connectorRef: "gmail",
      permission: "messages.write",
      action: "allow",
    });
    mocks.clerk.session(scenario.userId, scenario.orgId);

    const trigger = await createDueLoopTrigger(scenario, 60);

    await executeDueWorkflowTriggers();

    const run = await onlyWorkflowRunMessage(trigger.threadId);
    await runsApi.heartbeatRunner(scenario.runnerGroup);
    const claim = await runsApi.claimRunnerJob(run.runId);
    expect(claim.networkPolicies?.gmail?.allow ?? []).toContain(
      "messages.write",
    );
    await disableTrigger(trigger.triggerId);
  });

  it("does not expose workflow permission deep-link ids to the run environment", async () => {
    const scenario = await setup();
    const trigger = await createDueLoopTrigger(scenario, 60);

    await executeDueWorkflowTriggers();

    const run = await onlyWorkflowRunMessage(trigger.threadId);
    await runsApi.heartbeatRunner(scenario.runnerGroup);
    const claim = await runsApi.claimRunnerJob(run.runId);
    const environment = claim.environment ?? {};
    expect(environment.ZERO_WORKFLOW_TRIGGER_ID).toBeUndefined();
    expect(environment.ZERO_WORKFLOW_ID).toBeUndefined();
    await disableTrigger(trigger.triggerId);
  });

  it("fires a due cron trigger: creates a run, posts to the thread, sets last run state", async () => {
    const scenario = await setup({ timezone: "Asia/Shanghai" });
    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          schedule: {
            type: "cron",
            cronExpression: "0 9 * * *",
            timezone: "UTC",
          },
        },
      }),
      [201],
    );
    const threadId = created.body.chatThreadId;
    if (!threadId || !created.body.nextRunAt) {
      throw new Error("Expected a thread-bound cron trigger with a next run");
    }

    mockNow(Date.parse(created.body.nextRunAt) + 60_000);
    await executeDueWorkflowTriggers();

    const run = await onlyWorkflowRunMessage(threadId);
    expect(run.triggerSource).toBe("workflow-schedule");
    expect(run.triggerBrief).toMatch(
      new RegExp(
        `^${friendlyTriggeredAtPattern(
          "Asia/Shanghai",
        )}\\nSchedule: Every day at 5:00 PM$`,
        "u",
      ),
    );

    const trigger = await wf.readTrigger(created.body.id);
    expect(trigger.nextRunAt).toBeNull();
    expect(typeof trigger.lastRunAt).toBe("string");
  });

  it("disables a one-time trigger when it fires", async () => {
    const scenario = await setup({ timezone: "Asia/Shanghai" });
    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          schedule: {
            type: "once",
            atTime: new Date(now() + 90_000).toISOString(),
            timezone: "UTC",
          },
        },
      }),
      [201],
    );
    const threadId = created.body.chatThreadId;
    if (!threadId || !created.body.nextRunAt) {
      throw new Error("Expected a thread-bound one-time trigger");
    }

    mockNow(Date.parse(created.body.nextRunAt) + 60_000);
    await executeDueWorkflowTriggers();

    const trigger = await wf.readTrigger(created.body.id);
    expect(trigger.enabled).toBeFalsy();
    expect(trigger.nextRunAt).toBeNull();

    const run = await onlyWorkflowRunMessage(threadId);
    expect(run.triggerBrief).toMatch(
      new RegExp(
        `^Once at \\d{1,2}:\\d{2} [AP]M, [A-Z][a-z]{2} \\d{1,2}, \\d{4} \\(Asia\\/Shanghai\\)$`,
        "u",
      ),
    );
  });

  it("fires a due loop trigger with a persisted friendly trigger brief", async () => {
    const scenario = await setup({ timezone: "Asia/Shanghai" });
    const trigger = await createDueLoopTrigger(scenario, 3600);

    await executeDueWorkflowTriggers();

    const run = await onlyWorkflowRunMessage(trigger.threadId);
    expect(run.triggerBrief).toMatch(
      new RegExp(
        `^${friendlyTriggeredAtPattern("Asia/Shanghai")}\\nEvery 1 hour$`,
        "u",
      ),
    );
    await disableTrigger(trigger.triggerId);
  });

  it("skips a trigger whose previous run is still active", async () => {
    const scenario = await setup();
    const trigger = await createDueLoopTrigger(scenario, 60);

    // First tick fires a run that stays active (never claimed or completed).
    await executeDueWorkflowTriggers();
    await onlyWorkflowRunMessage(trigger.threadId);

    // Re-arm the schedule through the public update route, then move time
    // past the recomputed next run.
    const updated = await accept(
      triggersClient().update({
        headers: authHeaders(),
        params: { id: trigger.triggerId },
        body: { schedule: { type: "loop", intervalSeconds: 60 } },
      }),
      [200],
    );
    if (!updated.body.nextRunAt) {
      throw new Error("Expected the loop trigger to be rescheduled");
    }
    mockNow(Date.parse(updated.body.nextRunAt) + 1000);

    await executeDueWorkflowTriggers();

    // The due trigger was skipped: no second run message and the schedule is
    // left untouched for the next tick.
    const messages = await workflowRunMessages(trigger.threadId);
    expect(messages).toHaveLength(1);
    const read = await wf.readTrigger(trigger.triggerId);
    expect(read.enabled).toBeTruthy();
    expect(read.nextRunAt).toBe(updated.body.nextRunAt);

    await disableTrigger(trigger.triggerId);
  });

  it("skips a due trigger when the owner can no longer read the agent", async () => {
    const scenario = await setup();

    // A second org member owns the trigger on the public workflow. The member
    // becomes visible to the scheduler through a CLI-token request, which
    // caches the org membership the poller checks.
    const member = wf.user({
      userId: `user_${randomUUID()}`,
      orgId: scenario.orgId,
      orgRole: "org:member",
    });
    await store.set(
      seedOrgMembership$,
      { orgId: scenario.orgId, userId: member.userId, role: "member" },
      context.signal,
    );
    mocks.clerk.session(member.userId, scenario.orgId, "org:member");
    const apiKey = await runsApi.createApiKey(member);
    await accept(
      setupApp({ context })(zeroAgentsMainContract).list({
        headers: { authorization: `Bearer ${apiKey.token}` },
      }),
      [200],
    );

    mocks.clerk.session(member.userId, scenario.orgId, "org:member");
    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: { schedule: { type: "loop", intervalSeconds: 300 } },
      }),
      [201],
    );
    const threadId = created.body.chatThreadId;
    if (!threadId || !created.body.nextRunAt) {
      throw new Error("Expected a thread-bound loop trigger");
    }

    // The agent owner flips the agent private, hiding it from the member.
    mocks.clerk.session(scenario.userId, scenario.orgId);
    await accept(
      setupApp({ context })(zeroAgentsByIdContract).updateMetadata({
        headers: authHeaders(),
        params: { id: scenario.agentId },
        body: { visibility: "private" },
      }),
      [200],
    );

    await executeDueWorkflowTriggers();

    // Restore visibility so the member's product reads work again; the skip
    // already happened during the tick above.
    await accept(
      setupApp({ context })(zeroAgentsByIdContract).updateMetadata({
        headers: authHeaders(),
        params: { id: scenario.agentId },
        body: { visibility: "public" },
      }),
      [200],
    );

    // The member's due trigger was skipped without being disabled or fired.
    mocks.clerk.session(member.userId, scenario.orgId, "org:member");
    const read = await wf.readTrigger(created.body.id);
    expect(read.enabled).toBeTruthy();
    expect(read.nextRunAt).toBe(created.body.nextRunAt);
    expect(read.lastRunAt).toBeNull();
    const messages = await workflowRunMessages(threadId);
    expect(messages).toHaveLength(0);

    await disableTrigger(created.body.id);
    mocks.clerk.session(scenario.userId, scenario.orgId);
  });

  it("advances a cron trigger on the completion callback", async () => {
    const scenario = await setup();
    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          schedule: {
            type: "cron",
            cronExpression: "0 9 * * *",
            timezone: "UTC",
          },
        },
      }),
      [201],
    );
    const threadId = created.body.chatThreadId;
    if (!threadId || !created.body.nextRunAt) {
      throw new Error("Expected a thread-bound cron trigger");
    }

    mockNow(Date.parse(created.body.nextRunAt) + 60_000);
    await executeDueWorkflowTriggers();
    const run = await onlyWorkflowRunMessage(threadId);
    await completeRunThroughSandbox(scenario, run.runId, 0);

    await expect
      .poll(async () => {
        return (await wf.readTrigger(created.body.id)).nextRunAt;
      })
      .not.toBeNull();
    const trigger = await wf.readTrigger(created.body.id);
    expect(trigger.enabled).toBeTruthy();
  });

  it("reschedules a loop trigger by its interval on completion", async () => {
    const scenario = await setup();
    const trigger = await createDueLoopTrigger(scenario, 300);

    await executeDueWorkflowTriggers();
    const before = now();
    const run = await onlyWorkflowRunMessage(trigger.threadId);
    await completeRunThroughSandbox(scenario, run.runId, 0);

    await expect
      .poll(async () => {
        return (await wf.readTrigger(trigger.triggerId)).nextRunAt;
      })
      .not.toBeNull();
    const read = await wf.readTrigger(trigger.triggerId);
    if (!read.nextRunAt) {
      throw new Error("Expected the loop trigger to be rescheduled");
    }
    expect(Date.parse(read.nextRunAt)).toBeGreaterThanOrEqual(before + 290_000);
    await disableTrigger(trigger.triggerId);
  });

  it("auto-disables a trigger after three consecutive failures", async () => {
    const scenario = await setup();
    const trigger = await createDueLoopTrigger(scenario, 300);
    const base = now();
    const seenRunIds = new Set<string>();

    // Three fire + failed-completion cycles through the public cron, runner,
    // and sandbox completion surfaces auto-disable the trigger.
    for (let failure = 1; failure <= 3; failure += 1) {
      if (failure > 1) {
        mockNow(base + (failure - 1) * 320_000);
      }
      await executeDueWorkflowTriggers();
      const messages = await workflowRunMessages(trigger.threadId);
      const nextRun = messages.find((message) => {
        return !seenRunIds.has(message.runId);
      });
      if (!nextRun) {
        throw new Error(`Expected fire #${failure} to post a run message`);
      }
      seenRunIds.add(nextRun.runId);
      await completeRunThroughSandbox(scenario, nextRun.runId, 1);
      if (failure < 3) {
        await expect
          .poll(async () => {
            return (await wf.readTrigger(trigger.triggerId)).nextRunAt;
          })
          .not.toBeNull();
      }
    }

    await expect
      .poll(async () => {
        return (await wf.readTrigger(trigger.triggerId)).enabled;
      })
      .toBeFalsy();
    const read = await wf.readTrigger(trigger.triggerId);
    expect(read.nextRunAt).toBeNull();
  });

  it("cascade-deletes a workflow's triggers when the workflow is removed", async () => {
    const scenario = await setup();
    const trigger = await createDueLoopTrigger(scenario, 300);

    // Under the hard 1:N model a workflow belongs to exactly one agent; removing
    // the workflow cascade-deletes its triggers (FK onDelete: cascade).
    await deleteWorkflowViaApi(scenario);

    await accept(
      triggersClient().get({
        headers: authHeaders(),
        params: { id: trigger.triggerId },
      }),
      [404],
    );
  });
});
