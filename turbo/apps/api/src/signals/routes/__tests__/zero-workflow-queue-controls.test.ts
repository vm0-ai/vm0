import { createHash, randomUUID } from "node:crypto";

import { chatEventsContract } from "@vm0/api-contracts/contracts/chat-threads";
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
import { chatEventDisplayText } from "./helpers/chat-event";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const wf = createWorkflowsBddApi(context);
const runsApi = createRunsApi(context);
const webhooksApi = createWebhookCallbackApi(context);

const WORKFLOW_NAME = "workflow-queue-controls-workflow";

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function automationsClient() {
  return setupApp({ context })(zeroWorkflowAutomationsContract);
}

function chatMessagesClient() {
  return setupApp({ context })(chatEventsContract);
}

interface Scenario {
  readonly actor: ApiTestUser;
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly workflowId: string;
  readonly runnerGroup: string;
}

async function setup(): Promise<Scenario> {
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

interface ScheduleAutomation {
  readonly automationId: string;
  readonly threadId: string;
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

async function createScheduleAutomation(
  scenario: Scenario,
): Promise<ScheduleAutomation> {
  const created = await accept(
    automationsClient().create({
      headers: authHeaders(),
      params: { workflowId: scenario.workflowId },
      body: { schedule: { type: "loop", intervalSeconds: 3600 } },
    }),
    [201],
  );
  if (!created.body.chatThreadId) {
    throw new Error("Expected a thread-bound schedule automation");
  }
  return {
    automationId: created.body.id,
    threadId: created.body.chatThreadId,
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
  const messages = await wf.readThreadEvents(threadId);
  return messages.flatMap((message) => {
    if (
      message.eventType !== "input.prompt" ||
      chatEventDisplayText(message) !== `/${WORKFLOW_NAME}` ||
      !message.runId
    ) {
      return [];
    }
    return [message.runId];
  });
}

async function pendingWorkflowEvents(threadId: string) {
  const events = await wf.readThreadEvents(threadId);
  const revokedIds = new Set(
    events.flatMap((event) => {
      return event.revokesEventId ? [event.revokesEventId] : [];
    }),
  );
  return events.filter(
    (
      event,
    ): event is Extract<
      (typeof events)[number],
      { readonly eventType: "input.automation" }
    > => {
      return (
        event.eventType === "input.automation" &&
        event.runId === undefined &&
        !revokedIds.has(event.id)
      );
    },
  );
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

describe("workflow automation queue controls", () => {
  it("revokes one pending event with the caller's client event id", async () => {
    const { scenario, automation, runningRunId } = await busyQueueFixture(2);

    const before = await pendingWorkflowEvents(automation.threadId);
    const target = before[0];
    if (!target) {
      throw new Error("Expected a pending workflow event");
    }
    const clientEventId = randomUUID();
    await accept(
      chatMessagesClient().send({
        headers: authHeaders(),
        body: {
          agentId: scenario.agentId,
          threadId: automation.threadId,
          revokesEventId: target.id,
          clientEventId,
        },
      }),
      [201],
    );
    await expect(
      pendingWorkflowEvents(automation.threadId),
    ).resolves.toHaveLength(1);
    await expect(
      wf.readThreadEvents(automation.threadId),
    ).resolves.toContainEqual(
      expect.objectContaining({
        id: clientEventId,
        eventType: "control.revoke",
        revokesEventId: target.id,
      }),
    );

    // Only the remaining event drains after the running run completes.
    await completeRunThroughSandbox(scenario, runningRunId);
    const runIds = await workflowRunIds(automation.threadId);
    expect(runIds).toHaveLength(2);
    await completeRunThroughSandbox(scenario, runIds[1]!);
    await expect(workflowRunIds(automation.threadId)).resolves.toHaveLength(2);
  });

  it("queues manual Run now behind the active run and existing backlog", async () => {
    const scenario = await setup();
    const webhookAutomation = await createWebhookAutomation(scenario);
    const runningRunId = await postWorkflowWebhook(
      webhookAutomation,
      "running",
    );
    if (!runningRunId) {
      throw new Error("Expected the first webhook event to create a run");
    }
    await expect(
      postWorkflowWebhook(webhookAutomation, "already-pending"),
    ).resolves.toBeNull();

    const scheduleAutomation = await createScheduleAutomation(scenario);
    expect(scheduleAutomation.threadId).toBe(webhookAutomation.threadId);
    const manual = await accept(
      automationsClient().run({
        headers: authHeaders(),
        params: { id: scheduleAutomation.automationId },
      }),
      [201],
    );

    expect(manual.body).toStrictEqual({
      runId: null,
      chatThreadId: webhookAutomation.threadId,
    });
    expect(
      (await pendingWorkflowEvents(webhookAutomation.threadId)).map((event) => {
        return event.automationId;
      }),
    ).toStrictEqual([
      webhookAutomation.automationId,
      scheduleAutomation.automationId,
    ]);
    await expect(
      workflowRunIds(webhookAutomation.threadId),
    ).resolves.toStrictEqual([runningRunId]);
  });

  it("queues manual Run now behind an unclaimed user message on an idle thread", async () => {
    const scenario = await setup();
    const automation = await createScheduleAutomation(scenario);
    const first = await accept(
      automationsClient().run({
        headers: authHeaders(),
        params: { id: automation.automationId },
      }),
      [201],
    );
    if (!first.body.runId) {
      throw new Error("Expected the first manual run to start");
    }

    const userMessage = await accept(
      chatMessagesClient().send({
        headers: authHeaders(),
        body: {
          agentId: scenario.agentId,
          threadId: automation.threadId,
          prompt: "queued user message before manual Run now",
          userMessage: {
            version: 1,
            parts: [
              {
                type: "text",
                text: "queued user message before manual Run now",
              },
            ],
          },
        },
      }),
      [201],
    );
    expect(userMessage.body.runId).toBeNull();

    // Cancel the first run without flushing its deferred chat callback.
    // This leaves an idle thread whose oldest unclaimed work is the user message.
    await runsApi.requestCancelRun(scenario.actor, first.body.runId, [200]);
    await expect(
      runsApi.readRun(scenario.actor, first.body.runId),
    ).resolves.toMatchObject({ status: "cancelled" });

    const manual = await accept(
      automationsClient().run({
        headers: authHeaders(),
        params: { id: automation.automationId },
      }),
      [201],
    );
    expect(manual.body).toStrictEqual({
      runId: null,
      chatThreadId: automation.threadId,
    });

    expect(
      (await pendingWorkflowEvents(automation.threadId)).map((event) => {
        return event.automationId;
      }),
    ).toStrictEqual([automation.automationId]);
    const messages = await wf.readThreadEvents(automation.threadId);
    const claimedUserMessage = messages.find((message) => {
      return (
        chatEventDisplayText(message) ===
          "queued user message before manual Run now" &&
        typeof message.runId === "string"
      );
    });
    expect(claimedUserMessage?.runId).toStrictEqual(expect.any(String));

    await flushWaitUntilForTest();
  });

  it("keeps each explicit schedule Run now as a distinct queued event", async () => {
    const scenario = await setup();
    const automation = await createScheduleAutomation(scenario);

    const first = await accept(
      automationsClient().run({
        headers: authHeaders(),
        params: { id: automation.automationId },
      }),
      [201],
    );
    expect(first.body.runId).toStrictEqual(expect.any(String));

    for (let index = 0; index < 2; index++) {
      const queued = await accept(
        automationsClient().run({
          headers: authHeaders(),
          params: { id: automation.automationId },
        }),
        [201],
      );
      expect(queued.body.runId).toBeNull();
    }

    expect(
      (await pendingWorkflowEvents(automation.threadId)).map((event) => {
        return event.automationId;
      }),
    ).toStrictEqual([automation.automationId, automation.automationId]);
  });
});
