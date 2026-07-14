import { createHash } from "node:crypto";

import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { chatMessagesContract } from "@vm0/api-contracts/contracts/chat-threads";
import { zeroWorkflowAutomationsContract } from "@vm0/api-contracts/contracts/zero-workflows";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const wf = createWorkflowsBddApi(context);
const runsApi = createRunsApi(context);
const webhooksApi = createWebhookCallbackApi(context);

const WORKFLOW_NAME = "workflow-queue-workflow";
const CRON_EXECUTE_WORKFLOW_AUTOMATIONS_ROUTE =
  "/api/cron/execute-workflow-automations";
const CRON_SECRET = "test-cron-secret";

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function automationsClient() {
  return setupApp({ context })(zeroWorkflowAutomationsContract);
}

function chatMessagesClient() {
  return setupApp({ context })(chatMessagesContract);
}

interface Scenario {
  readonly actor: ApiTestUser;
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly workflowId: string;
  readonly runnerGroup: string;
}

async function setup(
  options: { readonly workflowQueue?: boolean } = {},
): Promise<Scenario> {
  const runnerGroup = runsApi.configureRunnerGroup();
  mockEnv("CRON_SECRET", CRON_SECRET);
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  const { actor } = await wf.setupWorkflowOrg({ tier: "team" });
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped workflow actor");
  }
  const agent = await wf.createAgent(actor, {
    displayName: "Workflow Queue Agent",
  });
  const workflowId = await wf.createWorkflow(actor, {
    agentId: agent.agentId,
    name: WORKFLOW_NAME,
  });
  const fixture = { orgId: actor.orgId, userId: actor.userId };
  await updateFeatureSwitchesForUser(
    context,
    fixture,
    options.workflowQueue === false
      ? {}
      : { [FeatureSwitchKey.WorkflowQueue]: true },
  );
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

interface WebhookAutomation {
  readonly automationId: string;
  readonly threadId: string;
  readonly token: string;
  readonly secret: string;
}

async function createWebhookAutomation(
  scenario: Scenario,
): Promise<WebhookAutomation> {
  const created = await accept(
    automationsClient().create({
      headers: authHeaders(),
      params: { workflowId: scenario.workflowId },
      body: { kind: "event", eventType: "webhook-received" },
    }),
    [201],
  );
  if (
    created.body.kind !== "event" ||
    created.body.eventType !== "webhook-received" ||
    !created.body.webhookUrl ||
    !created.body.webhookSecret ||
    !created.body.chatThreadId
  ) {
    throw new Error("Expected a thread-bound webhook automation with a secret");
  }
  const token = new URL(created.body.webhookUrl).pathname.split("/").at(-1);
  if (!token) {
    throw new Error("Expected webhook URL token");
  }
  return {
    automationId: created.body.id,
    threadId: created.body.chatThreadId,
    token,
    secret: created.body.webhookSecret,
  };
}

async function postWorkflowWebhook(
  automation: WebhookAutomation,
  payload: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const rawBody = JSON.stringify({ event: payload });
  const timestamp = Math.floor(now() / 1000);
  const response = await createApp({ signal: context.signal }).request(
    `/api/webhooks/workflow-automations/${automation.token}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-VM0-Timestamp": String(timestamp),
        "X-VM0-Signature": computeHmacSignature(
          rawBody,
          automation.secret,
          timestamp,
        ),
      },
      body: rawBody,
    },
  );
  return { status: response.status, body: await response.json() };
}

function expectAcceptedWithoutRun(result: {
  readonly status: number;
  readonly body: unknown;
}): void {
  expect(result.status).toBe(200);
  expect(result.body).toStrictEqual({ success: true, duplicate: false });
}

function expectAcceptedRunId(result: {
  readonly status: number;
  readonly body: unknown;
}): string {
  expect(result.status).toBe(200);
  expect(result.body).toStrictEqual({
    success: true,
    duplicate: false,
    runId: expect.any(String),
  });
  const runId = (result.body as { readonly runId: string }).runId;
  return runId;
}

/** Run ids of automation-fired `/workflow-name` user messages, oldest first. */
async function workflowRunIds(threadId: string): Promise<readonly string[]> {
  const messages = await wf.readThreadMessages(threadId);
  return messages.flatMap((message) => {
    if (
      message.role !== "user" ||
      message.content !== `/${WORKFLOW_NAME}` ||
      !message.runId
    ) {
      return [];
    }
    return [message.runId];
  });
}

async function completeRunThroughSandbox(
  scenario: Scenario,
  runId: string,
): Promise<void> {
  await runsApi.heartbeatRunner(scenario.runnerGroup);
  const claim = await runsApi.claimRunnerJob(runId);
  const sandboxHeaders = { authorization: `Bearer ${claim.sandboxToken}` };
  await webhooksApi.requestAgentCheckpoint(
    {
      runId,
      cliAgentType: "claude-code",
      cliAgentSessionId: `workflow-queue-cli-${runId}`,
      cliAgentSessionHistoryHash: createHash("sha256")
        .update(`workflow queue history ${runId}`)
        .digest("hex"),
    },
    sandboxHeaders,
    [200],
  );
  await webhooksApi.requestAgentComplete(
    { runId, exitCode: 0 },
    sandboxHeaders,
    [200],
  );
  await flushWaitUntilForTest();
}

async function executeDueWorkflowAutomations(): Promise<void> {
  const response = await createApp({ signal: context.signal }).request(
    CRON_EXECUTE_WORKFLOW_AUTOMATIONS_ROUTE,
    { headers: { authorization: `Bearer ${CRON_SECRET}` } },
  );
  expect(response.status).toBe(200);
}

describe("workflow queue", () => {
  it("queues webhook events behind the in-flight run and drains them serially", async () => {
    const scenario = await setup();
    const automation = await createWebhookAutomation(scenario);

    const first = await postWorkflowWebhook(automation, "first");
    const firstRunId = expectAcceptedRunId(first);

    // The workflow is busy: the next two events are accepted into the queue
    // without creating runs.
    expectAcceptedWithoutRun(await postWorkflowWebhook(automation, "second"));
    expectAcceptedWithoutRun(await postWorkflowWebhook(automation, "third"));
    await expect(workflowRunIds(automation.threadId)).resolves.toStrictEqual([
      firstRunId,
    ]);

    // Completing the run drains exactly one event into the next run.
    await completeRunThroughSandbox(scenario, firstRunId);
    const afterFirst = await workflowRunIds(automation.threadId);
    expect(afterFirst).toHaveLength(2);

    await completeRunThroughSandbox(scenario, afterFirst[1]!);
    const afterSecond = await workflowRunIds(automation.threadId);
    expect(afterSecond).toHaveLength(3);

    // The queue is empty: completing the last run creates nothing new.
    await completeRunThroughSandbox(scenario, afterSecond[2]!);
    await expect(workflowRunIds(automation.threadId)).resolves.toHaveLength(3);
  });

  it("keeps the current concurrent behavior when the switch is off", async () => {
    const scenario = await setup({ workflowQueue: false });
    const automation = await createWebhookAutomation(scenario);

    expectAcceptedRunId(await postWorkflowWebhook(automation, "first"));
    expectAcceptedRunId(await postWorkflowWebhook(automation, "second"));
    await expect(workflowRunIds(automation.threadId)).resolves.toHaveLength(2);
  });

  it("coalesces schedule ticks: at most one pending tick per automation", async () => {
    const scenario = await setup();
    const webhookAutomation = await createWebhookAutomation(scenario);

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
    if (!created.body.nextRunAt) {
      throw new Error("Expected a scheduled next run");
    }

    // Occupy the workflow with a webhook-triggered run.
    const busyRunId = expectAcceptedRunId(
      await postWorkflowWebhook(webhookAutomation, "busy"),
    );

    // Two due ticks while busy: the second coalesces into the pending one.
    mockNow(Date.parse(created.body.nextRunAt) + 60_000);
    await executeDueWorkflowAutomations();
    const updated = await accept(
      automationsClient().update({
        headers: authHeaders(),
        params: { id: created.body.id },
        body: {
          schedule: {
            type: "cron",
            cronExpression: "0 9 * * *",
            timezone: "UTC",
          },
        },
      }),
      [200],
    );
    if (!updated.body.nextRunAt) {
      throw new Error("Expected the updated automation to re-arm");
    }
    mockNow(Date.parse(updated.body.nextRunAt) + 60_000);
    await executeDueWorkflowAutomations();

    await completeRunThroughSandbox(scenario, busyRunId);
    const afterBusy = await workflowRunIds(webhookAutomation.threadId);
    expect(afterBusy).toHaveLength(2);

    // Only the single coalesced tick ran; nothing else is queued.
    await completeRunThroughSandbox(scenario, afterBusy[1]!);
    await expect(
      workflowRunIds(webhookAutomation.threadId),
    ).resolves.toHaveLength(2);
  });

  it("drains queued user chat messages before workflow events", async () => {
    const scenario = await setup();
    const automation = await createWebhookAutomation(scenario);
    // The queued-message auto-send runs inside the terminal chat callback,
    // which needs the run's assistant output (Axiom) and session-history
    // blobs (S3) to resolve.
    const chatCallbacks = createChatCallbacksApi(context);
    chatCallbacks.mockChatOutputEvents([
      {
        eventType: "assistant",
        sequenceNumber: 0,
        eventData: { message: { content: [{ type: "text", text: "done" }] } },
      },
    ]);
    chatCallbacks.acceptChatObjectStorage();

    const firstRunId = expectAcceptedRunId(
      await postWorkflowWebhook(automation, "first"),
    );
    expectAcceptedWithoutRun(await postWorkflowWebhook(automation, "second"));

    // A user message sent while the automation run is active joins the chat
    // message queue (no run yet).
    const queued = await accept(
      chatMessagesClient().send({
        headers: authHeaders(),
        body: {
          agentId: scenario.agentId,
          threadId: automation.threadId,
          prompt: "user interjection",
        },
      }),
      [201],
    );
    expect(queued.body.runId).toBeNull();

    // Terminal run: the user message drains first, the workflow event waits.
    await completeRunThroughSandbox(scenario, firstRunId);
    await expect(workflowRunIds(automation.threadId)).resolves.toHaveLength(1);
    const messages = await wf.readThreadMessages(automation.threadId);
    const userMessage = messages.find((message) => {
      return (
        message.content === "user interjection" &&
        typeof message.runId === "string"
      );
    });
    if (!userMessage?.runId) {
      throw new Error("Expected the queued user message to claim a run");
    }

    // The workflow event drains only after the user's run finishes.
    await completeRunThroughSandbox(scenario, userMessage.runId);
    await expect(workflowRunIds(automation.threadId)).resolves.toHaveLength(2);
  });
});
