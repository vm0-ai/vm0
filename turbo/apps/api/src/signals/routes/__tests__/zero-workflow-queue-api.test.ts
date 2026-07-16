import { createHash } from "node:crypto";

import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { zeroWorkflowQueueContract } from "@vm0/api-contracts/contracts/zero-workflow-queue";
import { zeroWorkflowAutomationsContract } from "@vm0/api-contracts/contracts/zero-workflows";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import type { ApiTestUser } from "./helpers/api-bdd";
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

const WORKFLOW_NAME = "workflow-queue-api-workflow";

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function automationsClient() {
  return setupApp({ context })(zeroWorkflowAutomationsContract);
}

function queueClient() {
  return setupApp({ context })(zeroWorkflowQueueContract);
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
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  const { actor } = await wf.setupWorkflowOrg({ tier: "team" });
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped workflow actor");
  }
  const agent = await wf.createAgent(actor, {
    displayName: "Workflow Queue API Agent",
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
      ? { [FeatureSwitchKey.WorkflowQueue]: false }
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
): Promise<string | null> {
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
  expect(response.status).toBe(200);
  const body = (await response.json()) as { readonly runId?: string };
  return body.runId ?? null;
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
      cliAgentSessionId: `workflow-queue-api-cli-${runId}`,
      cliAgentSessionHistoryHash: createHash("sha256")
        .update(`workflow queue api history ${runId}`)
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

/** Occupy the workflow with one run and leave `pendingCount` queued events. */
async function busyQueueFixture(pendingCount: number): Promise<{
  readonly scenario: Scenario;
  readonly automation: WebhookAutomation;
  readonly runningRunId: string;
}> {
  const scenario = await setup();
  const automation = await createWebhookAutomation(scenario);
  const runningRunId = await postWorkflowWebhook(automation, "busy");
  if (!runningRunId) {
    throw new Error("Expected the first webhook event to create a run");
  }
  for (let index = 0; index < pendingCount; index++) {
    const queued = await postWorkflowWebhook(automation, `pending-${index}`);
    expect(queued).toBeNull();
  }
  return { scenario, automation, runningRunId };
}

describe("workflow queue API", () => {
  it("returns the running run, FIFO pending events, and pause state", async () => {
    const { automation, runningRunId } = await busyQueueFixture(2);

    const queue = await accept(
      queueClient().get({
        headers: authHeaders(),
        params: { threadId: automation.threadId },
      }),
      [200],
    );
    expect(queue.body.running?.runId).toBe(runningRunId);
    expect(queue.body.pending).toHaveLength(2);
    expect(
      queue.body.pending.map((event) => {
        return event.triggerId;
      }),
    ).toStrictEqual([automation.automationId, automation.automationId]);
    expect(Date.parse(queue.body.pending[0]!.createdAt)).toBeLessThanOrEqual(
      Date.parse(queue.body.pending[1]!.createdAt),
    );
    expect(queue.body.pausedAt).toBeNull();
    expect(queue.body.pauseReason).toBeNull();
  });

  it("rejects queue reads when the feature switch is off", async () => {
    const scenario = await setup({ workflowQueue: false });
    const automation = await createWebhookAutomation(scenario);

    await accept(
      queueClient().get({
        headers: authHeaders(),
        params: { threadId: automation.threadId },
      }),
      [403],
    );
  });

  it("skips a single pending event", async () => {
    const { scenario, automation, runningRunId } = await busyQueueFixture(2);

    const before = await accept(
      queueClient().get({
        headers: authHeaders(),
        params: { threadId: automation.threadId },
      }),
      [200],
    );
    const skipped = await accept(
      queueClient().skipEvent({
        headers: authHeaders(),
        params: { id: before.body.pending[0]!.id },
      }),
      [200],
    );
    expect(skipped.body.pending).toHaveLength(1);

    // Only the remaining event drains after the running run completes.
    await completeRunThroughSandbox(scenario, runningRunId);
    const runIds = await workflowRunIds(automation.threadId);
    expect(runIds).toHaveLength(2);
    await completeRunThroughSandbox(scenario, runIds[1]!);
    await expect(workflowRunIds(automation.threadId)).resolves.toHaveLength(2);
  });

  it("clears all pending events", async () => {
    const { scenario, automation, runningRunId } = await busyQueueFixture(2);

    const cleared = await accept(
      queueClient().clear({
        headers: authHeaders(),
        params: { threadId: automation.threadId },
      }),
      [200],
    );
    expect(cleared.body.pending).toHaveLength(0);

    await completeRunThroughSandbox(scenario, runningRunId);
    await expect(workflowRunIds(automation.threadId)).resolves.toHaveLength(1);
  });

  it("pause freezes consumption while intake continues; resume drains", async () => {
    const { scenario, automation, runningRunId } = await busyQueueFixture(1);

    const paused = await accept(
      queueClient().pause({
        headers: authHeaders(),
        params: { threadId: automation.threadId },
      }),
      [200],
    );
    expect(paused.body.pausedAt).not.toBeNull();

    // Intake continues while paused.
    await expect(
      postWorkflowWebhook(automation, "while-paused"),
    ).resolves.toBeNull();

    // Terminal run does not drain a paused queue.
    await completeRunThroughSandbox(scenario, runningRunId);
    const stillPaused = await accept(
      queueClient().get({
        headers: authHeaders(),
        params: { threadId: automation.threadId },
      }),
      [200],
    );
    expect(stillPaused.body.running).toBeNull();
    expect(stillPaused.body.pending).toHaveLength(2);

    // Resume drains the head event immediately.
    const resumed = await accept(
      queueClient().resume({
        headers: authHeaders(),
        params: { threadId: automation.threadId },
      }),
      [200],
    );
    expect(resumed.body.pausedAt).toBeNull();
    expect(resumed.body.running).not.toBeNull();
    expect(resumed.body.pending).toHaveLength(1);
  });
});
