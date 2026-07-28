import { createHash, randomUUID } from "node:crypto";

import type { ChatEventResponse } from "@vm0/api-contracts/contracts/chat-threads";
import { zeroWorkflowAutomationsContract } from "@vm0/api-contracts/contracts/zero-workflows";
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
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { readAgentRunCallbacks$ } from "./helpers/agent-run-callback";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const wf = createWorkflowsBddApi(context);
const runsApi = createRunsApi(context);
const webhooksApi = createWebhookCallbackApi(context);
const chatFilesApi = createChatFilesBddApi(context);
const computerUseApi = createComputerUseBddApi(context);

const WORKFLOW_NAME = "scheduler-workflow";
const CRON_EXECUTE_WORKFLOW_AUTOMATIONS_ROUTE =
  "/api/cron/execute-workflow-automations";
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

function automationsClient() {
  return setupApp({ context })(zeroWorkflowAutomationsContract);
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

function zeroTokenFromClaim(
  claim: Awaited<ReturnType<typeof runsApi.claimRunnerJob>>,
): string {
  const token = claim.environment?.ZERO_TOKEN;
  if (!token || !token.startsWith("vm0_sandbox_")) {
    throw new Error("Expected the claim environment to carry a ZERO_TOKEN");
  }
  return token;
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

interface CreatedAutomation {
  readonly automationId: string;
  readonly threadId: string;
  readonly nextRunAt: string | null;
}

/** Loop automations are due immediately on creation. */
async function createDueLoopAutomation(
  scenario: Scenario,
  intervalSeconds: number,
): Promise<CreatedAutomation> {
  const created = await accept(
    automationsClient().create({
      headers: authHeaders(),
      params: { workflowId: scenario.workflowId },
      body: { schedule: { type: "loop", intervalSeconds } },
    }),
    [201],
  );
  if (!created.body.chatThreadId) {
    throw new Error("Expected the automation to bind a chat thread");
  }
  return {
    automationId: created.body.id,
    threadId: created.body.chatThreadId,
    nextRunAt: created.body.nextRunAt,
  };
}

async function disableAutomation(automationId: string): Promise<void> {
  await accept(
    automationsClient().disable({
      headers: authHeaders(),
      params: { id: automationId },
    }),
    [200],
  );
}

async function executeDueWorkflowAutomations(
  route = CRON_EXECUTE_WORKFLOW_AUTOMATIONS_ROUTE,
): Promise<void> {
  const response = await createApp({ signal: context.signal }).request(route, {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
  await expectOk(response, "execute workflow automations cron");
  const body = await readJson<{ readonly success: boolean }>(response);
  expect(body.success).toBeTruthy();
}

interface WorkflowRunMessage {
  readonly runId: string;
  readonly triggerSource: string | undefined;
  readonly automationId: string | undefined;
  readonly hasLegacyTriggerId: boolean;
  readonly triggerBrief: string | null | undefined;
  readonly workflowSnapshot: ChatEventResponse["workflowSnapshot"];
}

/**
 * Workflow-automation fires post a `/workflow-name` user message with the run id
 * into the bound thread; this is the public read for "runs of this automation".
 */
async function workflowRunMessages(
  threadId: string,
): Promise<readonly WorkflowRunMessage[]> {
  const messages = await wf.readThreadEvents(threadId);
  return messages.flatMap((message) => {
    if (
      message.eventType !== "input.prompt" ||
      message.content !== `/${WORKFLOW_NAME}` ||
      !message.runId
    ) {
      return [];
    }
    return [
      {
        runId: message.runId,
        triggerSource: message.triggerSource,
        automationId: message.workflowSnapshot?.automationId,
        hasLegacyTriggerId: Object.hasOwn(
          message.workflowSnapshot ?? {},
          "triggerId",
        ),
        triggerBrief: message.workflowSnapshot?.triggerBrief,
        workflowSnapshot: message.workflowSnapshot,
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
      cliAgentSessionId: `workflow-automation-cli-${runId}`,
      cliAgentSessionHistoryHash: createHash("sha256")
        .update(`workflow automation history ${runId}`)
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

describe("zero workflow automation scheduler", () => {
  it("inherits the chat thread computer-use grant for automation runs", async () => {
    const scenario = await setup();
    const automation = await createDueLoopAutomation(scenario, 3600);
    const host = await computerUseApi.startComputerUseHost(scenario.actor, {
      hostName: "Automation Desktop",
    });
    await chatFilesApi.updateThreadComputerUseHost(
      scenario.actor,
      automation.threadId,
      host.hostId,
    );

    await executeDueWorkflowAutomations();

    const run = await onlyWorkflowRunMessage(automation.threadId);
    await runsApi.heartbeatRunner(scenario.runnerGroup);
    const claim = await runsApi.claimRunnerJob(run.runId);
    await computerUseApi.requestCreateComputerUseWriteCommand(
      { bearer: zeroTokenFromClaim(claim) },
      [200],
    );
    const createdRun = await runsApi.readRun(scenario.actor, run.runId);
    expect(createdRun.appendSystemPrompt).toContain(
      "Computer Use is enabled for this run on Automation Desktop.",
    );
    await disableAutomation(automation.automationId);
  });

  it("returns actionable authorization guidance when an automation has no computer-use grant", async () => {
    const scenario = await setup();
    const automation = await createDueLoopAutomation(scenario, 3600);

    await executeDueWorkflowAutomations();

    const run = await onlyWorkflowRunMessage(automation.threadId);
    await runsApi.heartbeatRunner(scenario.runnerGroup);
    const claim = await runsApi.claimRunnerJob(run.runId);
    const denied = await computerUseApi.requestCreateComputerUseWriteCommand(
      { bearer: zeroTokenFromClaim(claim) },
      [403],
    );
    expect(denied.body).toMatchObject({
      error: {
        message:
          "Computer Use is not authorized for this run. Authorize a computer once in the conversation, then retry.",
      },
    });
    await disableAutomation(automation.automationId);
  });

  it("uses agent connector authorization and permission grants for automation runs", async () => {
    const scenario = await setup();

    // A real Gmail connection plus the public agent-connector and permission
    // grant routes, so the gmail firewall is built into the manifest.
    mockGmailConnectorOAuth({ email: "automation-user@example.com" });
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

    const automation = await createDueLoopAutomation(scenario, 60);

    await executeDueWorkflowAutomations();

    const run = await onlyWorkflowRunMessage(automation.threadId);
    await runsApi.heartbeatRunner(scenario.runnerGroup);
    const claim = await runsApi.claimRunnerJob(run.runId);
    expect(claim.networkPolicies?.gmail?.allow ?? []).toContain(
      "messages.write",
    );
    await disableAutomation(automation.automationId);
  });

  it("does not expose workflow permission deep-link ids to the run environment", async () => {
    const scenario = await setup();
    const automation = await createDueLoopAutomation(scenario, 60);

    await executeDueWorkflowAutomations();

    const run = await onlyWorkflowRunMessage(automation.threadId);
    await runsApi.heartbeatRunner(scenario.runnerGroup);
    const claim = await runsApi.claimRunnerJob(run.runId);
    const environment = claim.environment ?? {};
    expect(environment.ZERO_WORKFLOW_ID).toBeUndefined();
    await disableAutomation(automation.automationId);
  });

  it("fires a due cron automation: creates a run, posts to the thread, sets last run state", async () => {
    const scenario = await setup({ timezone: "Asia/Shanghai" });
    const created = await accept(
      automationsClient().create({
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
      throw new Error(
        "Expected a thread-bound cron automation with a next run",
      );
    }

    mockNow(Date.parse(created.body.nextRunAt) + 60_000);
    await executeDueWorkflowAutomations();

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

    const automation = await wf.readAutomation(created.body.id);
    expect(automation.nextRunAt).toBeNull();
    expect(typeof automation.lastRunAt).toBe("string");
  });

  it("disables a one-time automation when it fires", async () => {
    const scenario = await setup({ timezone: "Asia/Shanghai" });
    const created = await accept(
      automationsClient().create({
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
      throw new Error("Expected a thread-bound one-time automation");
    }

    mockNow(Date.parse(created.body.nextRunAt) + 60_000);
    await executeDueWorkflowAutomations();

    const emittedCallbacks = await store.set(
      readAgentRunCallbacks$,
      {
        orgId: scenario.orgId,
        userId: scenario.userId,
        prompt: `/${WORKFLOW_NAME}`,
      },
      context.signal,
    );
    const onceCallback = emittedCallbacks.find((callback) => {
      return callback.internalKind === "workflow-automation:cron";
    });
    expect(
      emittedCallbacks.every((callback) => {
        return !callback.hasEncryptedSecret;
      }),
    ).toBeTruthy();
    expect(onceCallback?.payload).toStrictEqual({
      automationId: created.body.id,
      timezone: "UTC",
    });
    expect(onceCallback?.status).toBe("pending");

    const automation = await wf.readAutomation(created.body.id);
    expect(automation.enabled).toBeFalsy();
    expect(automation.nextRunAt).toBeNull();

    const run = await onlyWorkflowRunMessage(threadId);
    expect(run.triggerBrief).toMatch(
      new RegExp(
        `^Once at \\d{1,2}:\\d{2} [AP]M, [A-Z][a-z]{2} \\d{1,2}, \\d{4} \\(Asia\\/Shanghai\\)$`,
        "u",
      ),
    );
  });

  it("fires a due loop automation with a persisted friendly automation brief", async () => {
    const scenario = await setup({ timezone: "Asia/Shanghai" });
    const automation = await createDueLoopAutomation(scenario, 3600);

    await executeDueWorkflowAutomations();

    const run = await onlyWorkflowRunMessage(automation.threadId);
    expect(run.triggerBrief).toMatch(
      new RegExp(
        `^${friendlyTriggeredAtPattern("Asia/Shanghai")}\\nEvery 1 hour$`,
        "u",
      ),
    );
    await disableAutomation(automation.automationId);
  });

  it("skips a due automation when the owner can no longer read the agent", async () => {
    const scenario = await setup();

    // A second org member owns the automation on the public workflow. The member
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
    const apiKey = await runsApi.createCliToken(member);
    await accept(
      setupApp({ context })(zeroAgentsMainContract).list({
        headers: { authorization: `Bearer ${apiKey.token}` },
      }),
      [200],
    );

    mocks.clerk.session(member.userId, scenario.orgId, "org:member");
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: { schedule: { type: "loop", intervalSeconds: 300 } },
      }),
      [201],
    );
    const threadId = created.body.chatThreadId;
    if (!threadId || !created.body.nextRunAt) {
      throw new Error("Expected a thread-bound loop automation");
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

    await executeDueWorkflowAutomations();

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

    // The member's due automation was skipped without being disabled or fired.
    mocks.clerk.session(member.userId, scenario.orgId, "org:member");
    const read = await wf.readAutomation(created.body.id);
    expect(read.enabled).toBeTruthy();
    expect(read.nextRunAt).toBe(created.body.nextRunAt);
    expect(read.lastRunAt).toBeNull();
    const messages = await workflowRunMessages(threadId);
    expect(messages).toHaveLength(0);

    await disableAutomation(created.body.id);
    mocks.clerk.session(scenario.userId, scenario.orgId);
  });

  it("advances a cron automation from a canonical-only callback", async () => {
    const scenario = await setup();
    const created = await accept(
      automationsClient().create({
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
      throw new Error("Expected a thread-bound cron automation");
    }

    mockNow(Date.parse(created.body.nextRunAt) + 60_000);
    await executeDueWorkflowAutomations();
    const run = await onlyWorkflowRunMessage(threadId);
    const emittedCallbacks = await store.set(
      readAgentRunCallbacks$,
      {
        orgId: scenario.orgId,
        userId: scenario.userId,
        prompt: `/${WORKFLOW_NAME}`,
      },
      context.signal,
    );
    const cronCallback = emittedCallbacks.find((callback) => {
      return callback.internalKind === "workflow-automation:cron";
    });
    expect(cronCallback?.payload).toStrictEqual({
      automationId: created.body.id,
      timezone: "UTC",
      cronExpression: "0 9 * * *",
    });
    expect(cronCallback?.status).toBe("pending");
    expect(run).toMatchObject({
      automationId: created.body.id,
      hasLegacyTriggerId: false,
    });
    expect(run.workflowSnapshot).toStrictEqual({
      id: scenario.workflowId,
      agentId: scenario.agentId,
      name: WORKFLOW_NAME,
      displayName: null,
      description: null,
      automationId: created.body.id,
      triggerBrief: expect.any(String),
    });
    await completeRunThroughSandbox(scenario, run.runId, 0);

    await expect
      .poll(async () => {
        return (await wf.readAutomation(created.body.id)).nextRunAt;
      })
      .not.toBeNull();
    const automation = await wf.readAutomation(created.body.id);
    expect(automation.enabled).toBeTruthy();
  });

  it("reschedules a loop automation from a canonical-only callback", async () => {
    const scenario = await setup();
    const automation = await createDueLoopAutomation(scenario, 300);

    await executeDueWorkflowAutomations();
    const before = now();
    const run = await onlyWorkflowRunMessage(automation.threadId);
    const emittedCallbacks = await store.set(
      readAgentRunCallbacks$,
      {
        orgId: scenario.orgId,
        userId: scenario.userId,
        prompt: `/${WORKFLOW_NAME}`,
      },
      context.signal,
    );
    const loopCallback = emittedCallbacks.find((callback) => {
      return callback.internalKind === "workflow-automation:loop";
    });
    expect(loopCallback?.payload).toStrictEqual({
      automationId: automation.automationId,
    });
    expect(loopCallback?.status).toBe("pending");
    expect(run).toMatchObject({
      automationId: automation.automationId,
      hasLegacyTriggerId: false,
    });
    expect(run.workflowSnapshot).toStrictEqual({
      id: scenario.workflowId,
      agentId: scenario.agentId,
      name: WORKFLOW_NAME,
      displayName: null,
      description: null,
      automationId: automation.automationId,
      triggerBrief: expect.any(String),
    });
    await completeRunThroughSandbox(scenario, run.runId, 0);

    await expect
      .poll(async () => {
        return (await wf.readAutomation(automation.automationId)).nextRunAt;
      })
      .not.toBeNull();
    const read = await wf.readAutomation(automation.automationId);
    if (!read.nextRunAt) {
      throw new Error("Expected the loop automation to be rescheduled");
    }
    expect(Date.parse(read.nextRunAt)).toBeGreaterThanOrEqual(before + 290_000);
    await disableAutomation(automation.automationId);
  });

  it("auto-disables an automation after three consecutive failures", async () => {
    const scenario = await setup();
    const automation = await createDueLoopAutomation(scenario, 300);
    const base = now();
    const seenRunIds = new Set<string>();

    // Three fire + failed-completion cycles through the public cron, runner,
    // and sandbox completion surfaces auto-disable the automation.
    for (let failure = 1; failure <= 3; failure += 1) {
      if (failure > 1) {
        mockNow(base + (failure - 1) * 320_000);
      }
      await executeDueWorkflowAutomations();
      const messages = await workflowRunMessages(automation.threadId);
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
            return (await wf.readAutomation(automation.automationId)).nextRunAt;
          })
          .not.toBeNull();
      }
    }

    await expect
      .poll(async () => {
        return (await wf.readAutomation(automation.automationId)).enabled;
      })
      .toBeFalsy();
    const read = await wf.readAutomation(automation.automationId);
    expect(read.nextRunAt).toBeNull();
  });

  it("preserves run messages when workflow deletion removes automation provenance", async () => {
    const scenario = await setup();
    const automation = await createDueLoopAutomation(scenario, 300);

    await executeDueWorkflowAutomations();
    const run = await onlyWorkflowRunMessage(automation.threadId);
    expect(run.workflowSnapshot).toMatchObject({
      id: scenario.workflowId,
      automationId: automation.automationId,
    });

    // Under the hard 1:N model a workflow belongs to exactly one agent; removing
    // the workflow cascade-deletes its automations (FK onDelete: cascade).
    await deleteWorkflowViaApi(scenario);

    await accept(
      automationsClient().get({
        headers: authHeaders(),
        params: { id: automation.automationId },
      }),
      [404],
    );

    const historicalRuns = await workflowRunMessages(automation.threadId);
    expect(historicalRuns).toStrictEqual([
      {
        runId: run.runId,
        triggerSource: "workflow-schedule",
        automationId: undefined,
        hasLegacyTriggerId: false,
        triggerBrief: undefined,
        workflowSnapshot: undefined,
      },
    ]);
  });
});
