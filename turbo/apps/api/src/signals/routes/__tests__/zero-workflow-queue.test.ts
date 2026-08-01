import { createHash, randomUUID } from "node:crypto";

import {
  GenerateDataKeyCommand,
  type GenerateDataKeyCommandOutput,
} from "@aws-sdk/client-kms";
import {
  chatEventsContract,
  chatThreadEventsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroModelProvidersByTypeContract } from "@vm0/api-contracts/contracts/zero-model-providers";
import { zeroWorkflowAutomationsContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { onTestFinished, test as vitestTest } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { mockNow, now, withNowScopeForTest } from "../../../lib/time";
import {
  createActiveGoalQueueEventFixture,
  readGoalQueueStateFixture,
} from "../../../test-fixtures/goal-queue";
import { admitWorkflowAutomationEventFixture } from "../../../test-fixtures/workflow-queue";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import {
  chatEventAutomationPart,
  chatEventDisplayText,
} from "./helpers/chat-event";
import { readThreadSessionBinding } from "./helpers/runtime-state";
import {
  generateDataKeyOutput,
  useSecretKmsProbe,
} from "./helpers/secret-kms-probe";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import {
  completeRunWithoutCallbacksFixture,
  holdChatEventQueueAdmissionLockFixture,
  holdOrgAdmissionLockFixture,
  readChatEventContextFixture,
  readChatEventInputParamsFixture,
  setQueuedUserMessageCreatedAtFixture,
  setWorkflowQueueEventCreatedAtFixture,
} from "../../../test-fixtures/chat-events";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const wf = createWorkflowsBddApi(context);
const runsApi = createRunsApi(context);
const webhooksApi = createWebhookCallbackApi(context);
const chatCallbacks = createChatCallbacksApi(context);

const WORKFLOW_NAME = "workflow-queue-workflow";
const CRON_CLEANUP_SANDBOXES_ROUTE = "/api/cron/cleanup-sandboxes";
const CRON_EXECUTE_WORKFLOW_AUTOMATIONS_ROUTE =
  "/api/cron/execute-workflow-automations";
const CRON_SECRET = "test-cron-secret";

function it(name: string, test: () => Promise<void>, timeout?: number): void {
  vitestTest(
    name,
    async () => {
      await withNowScopeForTest(test);
    },
    timeout,
  );
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function automationsClient() {
  return setupApp({ context })(zeroWorkflowAutomationsContract);
}

function chatEventsClient() {
  return setupApp({ context })(chatEventsContract);
}

function chatThreadEventsClient() {
  return setupApp({ context })(chatThreadEventsContract);
}

function modelProvidersByTypeClient() {
  return setupApp({ context })(zeroModelProvidersByTypeContract);
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
  mocks.clerk.session(actor.userId, actor.orgId);
  chatCallbacks.acceptChatObjectStorage();
  chatCallbacks.mockChatOutputEvents([]);
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
  signal: AbortSignal = context.signal,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const rawBody = JSON.stringify({ event: payload });
  const timestamp = Math.floor(now() / 1000);
  const response = await createApp({ signal }).request(
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

async function expectAcceptedRunId(
  result: {
    readonly status: number;
    readonly body: unknown;
  },
  threadId: string,
): Promise<string> {
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({
    success: true,
    duplicate: false,
  });
  const runId = (result.body as { readonly runId?: unknown }).runId;
  if (typeof runId === "string") {
    return runId;
  }

  // Another per-thread drain can win the queue-first claim after this request
  // admits the event. The webhook still reports an accepted event, so resolve
  // the run that owns the durable queue item instead of requiring this caller
  // to have created it.
  expect(result.body).toStrictEqual({ success: true, duplicate: false });
  await expect
    .poll(() => {
      return workflowRunIds(threadId);
    })
    .toHaveLength(1);
  const [claimedRunId] = await workflowRunIds(threadId);
  if (!claimedRunId) {
    throw new Error("Expected the accepted workflow event to create a run");
  }
  return claimedRunId;
}

/** Run ids of automation-fired `/workflow-name` user messages, oldest first. */
async function workflowRunIds(threadId: string): Promise<readonly string[]> {
  const messages = await wf.readThreadEvents(threadId);
  return messages.flatMap((message) => {
    if (
      message.eventType !== "input.prompt" ||
      chatEventAutomationPart(message)?.workflowName !== WORKFLOW_NAME ||
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

async function pendingWorkflowEventForAutomation(
  threadId: string,
  automationId: string,
) {
  for (const event of await pendingWorkflowEvents(threadId)) {
    const eventContext = await readChatEventContextFixture(event.id);
    if (eventContext?.automationId === automationId) {
      return event;
    }
  }
  return undefined;
}

async function completeRunThroughSandbox(scenario: Scenario, runId: string) {
  await runsApi.heartbeatRunner(scenario.runnerGroup);
  const claim = await runsApi.claimRunnerJob(runId);
  const sandboxHeaders = { authorization: `Bearer ${claim.sandboxToken}` };
  const stagedOutputEvents = chatCallbacks.consumeMockChatOutputEvents();
  if (stagedOutputEvents.length > 0) {
    await webhooksApi.requestAgentEvents(
      { runId, events: stagedOutputEvents },
      sandboxHeaders,
      [200],
    );
  }
  await webhooksApi.requestAgentCheckpoint(
    {
      runId,
      cliAgentType: "claude-code",
      cliAgentSessionId: `workflow-queue-cli-${runId}`,
      cliAgentSessionHistoryHash: createHash("sha256")
        .update(`workflow automation history ${runId}`)
        .digest("hex"),
    },
    sandboxHeaders,
    [200],
  );
  await webhooksApi.requestAgentComplete(
    {
      runId,
      exitCode: 0,
      ...(stagedOutputEvents.length === 0
        ? {}
        : {
            lastEventSequence: Math.max(
              ...stagedOutputEvents.map((event) => {
                return event.sequenceNumber;
              }),
            ),
          }),
    },
    sandboxHeaders,
    [200],
  );
  await flushWaitUntilForTest();
  return claim;
}

async function executeDueWorkflowAutomations(): Promise<void> {
  const response = await createApp({ signal: context.signal }).request(
    CRON_EXECUTE_WORKFLOW_AUTOMATIONS_ROUTE,
    { headers: { authorization: `Bearer ${CRON_SECRET}` } },
  );
  expect(response.status).toBe(200);
}

async function cleanupSandboxes(): Promise<void> {
  const response = await createApp({ signal: context.signal }).request(
    CRON_CLEANUP_SANDBOXES_ROUTE,
    { headers: { authorization: `Bearer ${CRON_SECRET}` } },
  );
  expect(response.status).toBe(200);
}

/**
 * Product-visible proof that the stale sweep admitted nothing on this thread
 * while a request is still blocked on the org admission lock.
 *
 * The sweep runs inline in the cron request, so `cleanupSandboxes()` returning
 * at all already shows it never reached that lock — any attempt would block on
 * the hold this test owns. This asserts the outcome half through the queue API:
 * the pending events are exactly the ones queued before the sweep, and no
 * queued item was drained into a run.
 *
 * Deliberately not asserted through `admissionLock.waiterCount()`: that counter
 * is a cluster-wide `pg_locks` observation of one `hashtext(orgId)` key shared
 * by several admission paths, and it never decreases while the lock is held, so
 * any unrelated arrival is permanent. It is a sound lower-bound barrier and an
 * unsound equality contract.
 */
async function expectSweepLeftQueueUntouched(
  threadId: string,
  pendingEventIds: readonly string[],
): Promise<void> {
  expect(
    (await pendingWorkflowEvents(threadId)).map((event) => {
      return event.id;
    }),
  ).toStrictEqual(pendingEventIds);
  const messages = await wf.readThreadEvents(threadId);
  expect(
    messages.filter((message) => {
      return typeof message.runId === "string";
    }),
  ).toStrictEqual([]);
}

describe("workflow queue", () => {
  it("runs a pending workflow event before an older goal continuation on the same thread", async () => {
    const scenario = await setup();
    const automation = await createWebhookAutomation(scenario);
    const goal = await createActiveGoalQueueEventFixture({
      threadId: automation.threadId,
      orgId: scenario.orgId,
      userId: scenario.userId,
      agentId: scenario.agentId,
      objective: "finish after the workflow event",
      objectiveBrief: "Finish after the workflow event",
    });

    const workflowRunId = await expectAcceptedRunId(
      await postWorkflowWebhook(automation, "workflow wins queue priority"),
      automation.threadId,
    );
    const goalQueue = await readGoalQueueStateFixture(automation.threadId);
    expect(goalQueue.runIds).toHaveLength(0);
    expect(goalQueue.eventIds).toContain(goal.eventId);

    await runsApi.requestCancelRun(scenario.actor, workflowRunId, [200]);
  });

  it("does not let the stale sweep race a newly admitted workflow event", async () => {
    mockNow(Date.UTC(2020, 0, 1));
    const scenario = await setup();
    const automation = await createWebhookAutomation(scenario);
    const admissionLock = await holdOrgAdmissionLockFixture({
      orgId: scenario.orgId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      admissionLock.release();
      await admissionLock.done;
    });

    const workflowRequest = postWorkflowWebhook(automation, "fresh event");
    await expect.poll(admissionLock.waiterCount).toBeGreaterThanOrEqual(1);
    const event = (await pendingWorkflowEvents(automation.threadId))[0];
    if (!event) {
      throw new Error("Expected a pending workflow event");
    }

    // The business assertion: the stale sweep must not race the freshly
    // admitted event that is still blocked on org admission.
    await cleanupSandboxes();
    await expectSweepLeftQueueUntouched(automation.threadId, [event.id]);

    admissionLock.release();
    const result = await workflowRequest;
    await admissionLock.done;
    const runId = await expectAcceptedRunId(result, automation.threadId);
    await expect(workflowRunIds(automation.threadId)).resolves.toStrictEqual([
      runId,
    ]);
  });

  it("does not let the stale sweep drain a fresh user message ahead of a stale workflow event", async () => {
    mockNow(Date.UTC(2020, 0, 1));
    const scenario = await setup();
    const automation = await createWebhookAutomation(scenario);
    const admissionLock = await holdOrgAdmissionLockFixture({
      orgId: scenario.orgId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      admissionLock.release();
      await admissionLock.done;
    });

    const workflowRequest = postWorkflowWebhook(automation, "stale event");
    await expect.poll(admissionLock.waiterCount).toBeGreaterThanOrEqual(1);
    const event = (await pendingWorkflowEvents(automation.threadId))[0];
    if (!event) {
      throw new Error("Expected a pending workflow event");
    }
    await setWorkflowQueueEventCreatedAtFixture({
      eventId: event.id,
      createdAt: new Date("2019-12-31T23:54:00.000Z"),
    });

    const userRequest = chatEventsClient().send({
      headers: authHeaders(),
      body: {
        agentId: scenario.agentId,
        threadId: automation.threadId,
        prompt: "fresh user message",
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: "fresh user message" }],
        },
      },
    });
    // The persisted queued message is the product milestone proving the send
    // reached the queue; the waiter count is a cluster-wide `pg_locks`
    // observation of one org key that several admission attempts share, so it
    // is only used as a lower-bound barrier here.
    await expect
      .poll(async () => {
        const messages = await wf.readThreadEvents(automation.threadId);
        return messages.some((message) => {
          return chatEventDisplayText(message) === "fresh user message";
        });
      })
      .toBe(true);
    await expect.poll(admissionLock.waiterCount).toBeGreaterThanOrEqual(2);

    // The business assertion: the stale sweep must leave the fresh user message
    // queued and must not drain it ahead of the stale workflow event that is
    // still blocked on org admission.
    await cleanupSandboxes();
    await expectSweepLeftQueueUntouched(automation.threadId, [event.id]);

    admissionLock.release();
    const [workflowResult, userResult] = await Promise.all([
      workflowRequest,
      accept(userRequest, [201]),
    ]);
    await admissionLock.done;
    expect(workflowResult.status).toBe(200);
    expect(userResult.status).toBe(201);
  });

  it("recovers a stale workflow event after its terminal callback is missed", async () => {
    mockNow(Date.UTC(2020, 0, 1));
    const scenario = await setup();
    const automation = await createWebhookAutomation(scenario);
    const firstRunId = await expectAcceptedRunId(
      await postWorkflowWebhook(automation, "first"),
      automation.threadId,
    );
    expectAcceptedWithoutRun(
      await postWorkflowWebhook(automation, "stale pending event"),
    );
    const event = (await pendingWorkflowEvents(automation.threadId))[0];
    if (!event) {
      throw new Error("Expected a pending workflow event");
    }
    await setWorkflowQueueEventCreatedAtFixture({
      eventId: event.id,
      createdAt: new Date("2019-12-31T23:54:00.000Z"),
    });

    await runsApi.heartbeatRunner(scenario.runnerGroup);
    await runsApi.claimRunnerJob(firstRunId);
    await completeRunWithoutCallbacksFixture({ runId: firstRunId });

    await cleanupSandboxes();

    await expect(
      pendingWorkflowEvents(automation.threadId),
    ).resolves.toHaveLength(0);
    await expect(workflowRunIds(automation.threadId)).resolves.toHaveLength(2);
  });

  it("recovers a stale user message after its terminal callback is missed", async () => {
    mockNow(Date.UTC(2020, 0, 1));
    const scenario = await setup();
    const automation = await createWebhookAutomation(scenario);
    const firstRunId = await expectAcceptedRunId(
      await postWorkflowWebhook(automation, "first"),
      automation.threadId,
    );
    const messageId = randomUUID();
    const queued = await accept(
      chatEventsClient().send({
        headers: authHeaders(),
        body: {
          agentId: scenario.agentId,
          threadId: automation.threadId,
          prompt: "stale user message",
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "stale user message" }],
          },
          clientEventId: messageId,
        },
      }),
      [201],
    );
    expect(queued.body.runId).toBeNull();
    await setQueuedUserMessageCreatedAtFixture({
      eventId: messageId,
      createdAt: new Date("2019-12-31T23:54:00.000Z"),
    });

    await runsApi.heartbeatRunner(scenario.runnerGroup);
    await runsApi.claimRunnerJob(firstRunId);
    await completeRunWithoutCallbacksFixture({ runId: firstRunId });

    await cleanupSandboxes();

    const messages = await wf.readThreadEvents(automation.threadId);
    expect(messages).toContainEqual(
      expect.objectContaining({
        content: null,
        revokesEventId: messageId,
        runId: expect.any(String),
      }),
    );
    expect(
      messages.some((message) => {
        return (
          message.revokesEventId === messageId &&
          chatEventDisplayText(message) === "stale user message"
        );
      }),
    ).toBeTruthy();
  });

  it("queues webhook events behind the active run and drains one per completion", async () => {
    const scenario = await setup();
    const automation = await createWebhookAutomation(scenario);
    const kms = useSecretKmsProbe();

    const first = await postWorkflowWebhook(automation, "first");
    const firstRunId = await expectAcceptedRunId(first, automation.threadId);
    // Workflow admission stores no encrypted launch blob. The only data key is
    // for the launched run's execution secrets.
    expect(kms.generateDataKeyCalls).toBe(1);

    // The workflow is busy: the next two events are accepted into the queue
    // without creating runs.
    const secondApiStartTime = now() + 60_000;
    mockNow(secondApiStartTime);
    expectAcceptedWithoutRun(await postWorkflowWebhook(automation, "second"));
    expect(kms.generateDataKeyCalls).toBe(1);
    mockNow(secondApiStartTime + 1000);
    expectAcceptedWithoutRun(await postWorkflowWebhook(automation, "third"));
    expect(kms.generateDataKeyCalls).toBe(1);
    const pendingEvents = await pendingWorkflowEvents(automation.threadId);
    expect(pendingEvents).toHaveLength(2);
    const secondEvent = pendingEvents[0];
    const thirdEvent = pendingEvents[1];
    if (!secondEvent || !thirdEvent) {
      throw new Error("Expected two pending workflow queue events");
    }
    await expect(
      readChatEventInputParamsFixture(secondEvent.id),
    ).resolves.toBeNull();
    await expect(
      readChatEventInputParamsFixture(thirdEvent.id),
    ).resolves.toBeNull();
    await expect(workflowRunIds(automation.threadId)).resolves.toStrictEqual([
      firstRunId,
    ]);

    // Completing the run drains exactly one event into the next run.
    const dequeuedAt = secondApiStartTime + 10_000;
    mockNow(dequeuedAt);
    await completeRunThroughSandbox(scenario, firstRunId);
    const afterFirst = await workflowRunIds(automation.threadId);
    expect(afterFirst).toHaveLength(2);
    await expect(
      readChatEventInputParamsFixture(secondEvent.id),
    ).resolves.toBeNull();
    const secondClaim = await completeRunThroughSandbox(
      scenario,
      afterFirst[1]!,
    );
    expect(secondClaim.apiStartTime).toBe(dequeuedAt);
    await expect(
      readChatEventInputParamsFixture(thirdEvent.id),
    ).resolves.toBeNull();
  });

  it("keeps workflow events queued until cancellation recovery completes", async () => {
    const scenario = await setup();
    const automation = await createWebhookAutomation(scenario);
    const firstRunId = await expectAcceptedRunId(
      await postWorkflowWebhook(automation, "first"),
      automation.threadId,
    );
    await runsApi.heartbeatRunner(scenario.runnerGroup);
    const firstClaim = await runsApi.claimRunnerJob(firstRunId);
    expectAcceptedWithoutRun(
      await postWorkflowWebhook(automation, "wait for recovery"),
    );

    await runsApi.requestCancelRun(scenario.actor, firstRunId, [200]);
    await flushWaitUntilForTest();
    await expect(workflowRunIds(automation.threadId)).resolves.toStrictEqual([
      firstRunId,
    ]);

    await webhooksApi.requestAgentComplete(
      { runId: firstRunId, exitCode: 1, error: "Run cancelled" },
      { authorization: `Bearer ${firstClaim.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
    const runIds = await workflowRunIds(automation.threadId);
    expect(runIds).toHaveLength(2);
    const secondRunId = runIds[1];
    if (!secondRunId) {
      throw new Error("Expected cancellation recovery to launch a second run");
    }
    await runsApi.requestCancelRun(scenario.actor, secondRunId, [200]);
    await flushWaitUntilForTest();
  });

  it("labels a queued schedule tick with the time it fired, not the time it drained", async () => {
    // Keep this global cron scan before schedules created by parallel test files.
    mockNow(Date.UTC(2020, 0, 2));
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

    // Occupy the thread so the tick has to wait in the queue.
    const busyRunId = await expectAcceptedRunId(
      await postWorkflowWebhook(webhookAutomation, "busy"),
      webhookAutomation.threadId,
    );

    const firedAt = Date.parse(created.body.nextRunAt) + 60_000;
    mockNow(firedAt);
    await executeDueWorkflowAutomations();
    const pendingTick = await pendingWorkflowEventForAutomation(
      webhookAutomation.threadId,
      created.body.id,
    );
    if (!pendingTick) {
      throw new Error("Expected the schedule tick to remain pending");
    }
    const admittedTriggerBrief =
      chatEventAutomationPart(pendingTick)?.automationBrief;
    if (admittedTriggerBrief === undefined) {
      throw new Error("Expected the admitted schedule tick trigger brief");
    }
    const pendingContext = await readChatEventContextFixture(pendingTick.id);
    expect(pendingContext).toMatchObject({
      contextType: "automation",
      contextId: expect.any(String),
      automationId: created.body.id,
      triggerBrief: admittedTriggerBrief,
      workflowName: WORKFLOW_NAME,
      workflowEventType: "schedule",
      workflowEventPayload: expect.objectContaining({
        automationId: created.body.id,
        trigger: "schedule",
        firedAt: new Date(firedAt).toISOString(),
      }),
    });

    // A later, unrelated drain pass launches the tick. Its trigger line must
    // still report the fire time, not this drain time.
    const drainedAt = firedAt + 600_000;
    mockNow(drainedAt);
    await completeRunThroughSandbox(scenario, busyRunId);
    const runIds = await workflowRunIds(webhookAutomation.threadId);
    expect(runIds).toHaveLength(2);
    const claimedTick = (
      await wf.readThreadEvents(webhookAutomation.threadId)
    ).find((event) => {
      return event.eventType === "input.prompt" && event.runId === runIds[1];
    });
    if (!claimedTick) {
      throw new Error("Expected the schedule tick to be claimed");
    }
    expect(chatEventAutomationPart(claimedTick)?.automationBrief).toBe(
      admittedTriggerBrief,
    );
    await expect(
      readChatEventContextFixture(claimedTick.id),
    ).resolves.toMatchObject({
      contextType: "automation",
      contextId: pendingContext?.contextId,
      automationId: created.body.id,
      triggerBrief: admittedTriggerBrief,
    });

    await runsApi.heartbeatRunner(scenario.runnerGroup);
    const claim = await runsApi.claimRunnerJob(runIds[1]!);
    expect(claim.prompt).toBe(
      `/${WORKFLOW_NAME}\nTrigger: schedule fired at ${new Date(
        firedAt,
      ).toISOString()} (cron "0 9 * * *" in UTC).`,
    );
    expect(claim.prompt).not.toContain(new Date(drainedAt).toISOString());
    expect(claim.appendSystemPrompt).toContain(
      `"firedAt": "${new Date(firedAt).toISOString()}"`,
    );
  });

  it("coalesces schedule ticks: at most one pending tick per automation", async () => {
    // Keep this global cron scan before schedules created by parallel test files.
    mockNow(Date.UTC(2020, 0, 1));
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
    const kms = useSecretKmsProbe();

    // Occupy the workflow with a webhook-triggered run.
    const busyRunId = await expectAcceptedRunId(
      await postWorkflowWebhook(webhookAutomation, "busy"),
      webhookAutomation.threadId,
    );
    expect(kms.generateDataKeyCalls).toBe(1);

    // Two due ticks while busy: the second coalesces into the pending one.
    mockNow(Date.parse(created.body.nextRunAt) + 60_000);
    await executeDueWorkflowAutomations();
    expect(kms.generateDataKeyCalls).toBe(1);
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
    const coalescedKms = useSecretKmsProbe();
    mockNow(Date.parse(updated.body.nextRunAt) + 60_000);
    await executeDueWorkflowAutomations();
    expect(coalescedKms.generateDataKeyCalls).toBe(0);
    const coalescedEvents = await pendingWorkflowEvents(
      webhookAutomation.threadId,
    );
    expect(coalescedEvents).toHaveLength(1);
    const coalescedEvent = coalescedEvents[0];
    if (!coalescedEvent) {
      throw new Error("Expected one coalesced schedule queue event");
    }
    await expect(
      readChatEventContextFixture(coalescedEvent.id),
    ).resolves.toMatchObject({
      automationId: created.body.id,
    });
    await expect(
      readChatEventInputParamsFixture(coalescedEvent.id),
    ).resolves.toBeNull();
    await completeRunThroughSandbox(scenario, busyRunId);
    const afterBusy = await workflowRunIds(webhookAutomation.threadId);
    expect(afterBusy).toHaveLength(2);

    // Only the single coalesced tick ran; nothing else is queued.
    await completeRunThroughSandbox(scenario, afterBusy[1]!);
    await expect(
      workflowRunIds(webhookAutomation.threadId),
    ).resolves.toHaveLength(2);
  });

  it("serializes concurrent workflow admissions for the same thread", async () => {
    const scenario = await setup();
    const automation = await createWebhookAutomation(scenario);
    const admissionLock = await holdChatEventQueueAdmissionLockFixture({
      threadId: automation.threadId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      admissionLock.release();
      await admissionLock.done;
    });

    const firstRequest = postWorkflowWebhook(automation, "first concurrent");
    await expect.poll(admissionLock.directWaiterCount).toBe(1);

    const secondRequest = postWorkflowWebhook(automation, "second concurrent");
    await expect.poll(admissionLock.directWaiterCount).toBe(2);
    await expect(
      pendingWorkflowEvents(automation.threadId),
    ).resolves.toStrictEqual([]);

    admissionLock.release();
    const results = await Promise.all([firstRequest, secondRequest]);
    await admissionLock.done;

    expect(
      results.map((result) => {
        return result.status;
      }),
    ).toStrictEqual([200, 200]);
    await expect(workflowRunIds(automation.threadId)).resolves.toHaveLength(1);
    await expect(
      pendingWorkflowEvents(automation.threadId),
    ).resolves.toHaveLength(1);
  });

  it("uses full PostgreSQL timestamp precision for workflow queue FIFO", async () => {
    const scenario = await setup();
    const automation = await createWebhookAutomation(scenario);
    const firstBrief = "First precise workflow event";
    const firstEventId = await admitWorkflowAutomationEventFixture({
      automationId: automation.automationId,
      chatThreadId: automation.threadId,
      triggerBrief: firstBrief,
    });
    const secondBrief = "Second precise workflow event";
    const secondEventId = await admitWorkflowAutomationEventFixture({
      automationId: automation.automationId,
      chatThreadId: automation.threadId,
      triggerBrief: secondBrief,
    });
    const firstSortsBeforeSecond =
      firstEventId.localeCompare(secondEventId) < 0;
    const databaseFirst = firstSortsBeforeSecond
      ? { id: secondEventId, brief: secondBrief }
      : { id: firstEventId, brief: firstBrief };
    const databaseSecond = firstSortsBeforeSecond
      ? { id: firstEventId, brief: firstBrief }
      : { id: secondEventId, brief: secondBrief };

    // Both values become the same JavaScript Date. The database-first event
    // deliberately has the lexicographically later UUID, so a millisecond
    // conversion followed by an id sort would choose the wrong queue head.
    await setWorkflowQueueEventCreatedAtFixture({
      eventId: databaseFirst.id,
      createdAt: "2019-12-31 23:54:00.000100",
    });
    await setWorkflowQueueEventCreatedAtFixture({
      eventId: databaseSecond.id,
      createdAt: "2019-12-31 23:54:00.000900",
    });

    const result = await postWorkflowWebhook(
      automation,
      "drain the precise workflow queue",
    );
    expectAcceptedWithoutRun(result);

    const [runId] = await workflowRunIds(automation.threadId);
    if (!runId) {
      throw new Error(
        "Expected the database-first queue event to create a run",
      );
    }
    const claimedEvent = (await wf.readThreadEvents(automation.threadId)).find(
      (event) => {
        return event.runId === runId && event.eventType === "input.prompt";
      },
    );
    expect(
      claimedEvent
        ? chatEventAutomationPart(claimedEvent)?.automationBrief
        : undefined,
    ).toBe(databaseFirst.brief);
    expect(
      (await pendingWorkflowEvents(automation.threadId)).map((event) => {
        return event.id;
      }),
    ).toContain(databaseSecond.id);
  });

  it("retries when an earlier workflow event becomes queue head during launch", async () => {
    const scenario = await setup();
    const automation = await createWebhookAutomation(scenario);
    const originalEventId = await admitWorkflowAutomationEventFixture({
      automationId: automation.automationId,
      chatThreadId: automation.threadId,
      triggerBrief: "Original queued workflow event",
    });
    await setWorkflowQueueEventCreatedAtFixture({
      eventId: originalEventId,
      createdAt: new Date("2019-12-31T23:55:00.000Z"),
    });

    const admissionLock = await holdOrgAdmissionLockFixture({
      orgId: scenario.orgId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      admissionLock.release();
      await admissionLock.done;
    });

    const workflowRequest = postWorkflowWebhook(
      automation,
      "launch while queue head changes",
    );
    await expect.poll(admissionLock.waiterCount).toBeGreaterThanOrEqual(1);

    const preemptingBrief = "Earlier workflow event admitted during launch";
    const preemptingEventId = await admitWorkflowAutomationEventFixture({
      automationId: automation.automationId,
      chatThreadId: automation.threadId,
      triggerBrief: preemptingBrief,
    });
    await setWorkflowQueueEventCreatedAtFixture({
      eventId: preemptingEventId,
      createdAt: new Date("2019-12-31T23:54:00.000Z"),
    });

    admissionLock.release();
    const result = await workflowRequest;
    await admissionLock.done;
    expectAcceptedWithoutRun(result);

    const [runId] = await workflowRunIds(automation.threadId);
    if (!runId) {
      throw new Error("Expected the replacement queue head to create a run");
    }
    const claimedEvent = (await wf.readThreadEvents(automation.threadId)).find(
      (event) => {
        return event.runId === runId && event.eventType === "input.prompt";
      },
    );
    expect(
      claimedEvent
        ? chatEventAutomationPart(claimedEvent)?.automationBrief
        : undefined,
    ).toBe(preemptingBrief);
    const pendingEventIds = (
      await pendingWorkflowEvents(automation.threadId)
    ).map((event) => {
      return event.id;
    });
    expect(pendingEventIds).toHaveLength(2);
    expect(pendingEventIds).toContain(originalEventId);
  });

  it("keeps claimed automation context after the automation is deleted", async () => {
    const scenario = await setup();
    const automation = await createWebhookAutomation(scenario);
    const runId = await expectAcceptedRunId(
      await postWorkflowWebhook(automation, "preserve historical context"),
      automation.threadId,
    );
    const claimedEvent = (await wf.readThreadEvents(automation.threadId)).find(
      (event) => {
        return event.eventType === "input.prompt" && event.runId === runId;
      },
    );
    if (!claimedEvent) {
      throw new Error("Expected the workflow event to be claimed");
    }
    const contextBeforeDelete = await readChatEventContextFixture(
      claimedEvent.id,
    );
    expect(contextBeforeDelete).toMatchObject({
      contextType: "automation",
      contextId: expect.any(String),
      automationId: automation.automationId,
    });

    await accept(
      automationsClient().delete({
        headers: authHeaders(),
        params: { id: automation.automationId },
      }),
      [204],
    );

    await expect(
      readChatEventContextFixture(claimedEvent.id),
    ).resolves.toStrictEqual(contextBeforeDelete);
    await runsApi.requestCancelRun(scenario.actor, runId, [200]);
  });

  it("propagates queue encryption failure while persistence remains necessary", async () => {
    const scenario = await setup();
    const automation = await createWebhookAutomation(scenario);
    const firstRunId = await expectAcceptedRunId(
      await postWorkflowWebhook(automation, "first"),
      automation.threadId,
    );

    const encryptionError = new Error("queue payload encryption failed");
    const kms = useSecretKmsProbe((_command, callNumber) => {
      return callNumber === 1 ? Promise.reject(encryptionError) : undefined;
    });

    const failed = await postWorkflowWebhook(automation, "second");
    expect(failed).toStrictEqual({
      status: 500,
      body: { error: "Internal server error" },
    });
    expect(kms.generateDataKeyCalls).toBe(1);
    expect(context.mocks.sentry.captureException).toHaveBeenCalledWith(
      encryptionError,
    );

    await expect(workflowRunIds(automation.threadId)).resolves.toStrictEqual([
      firstRunId,
    ]);
    await completeRunThroughSandbox(scenario, firstRunId);
    await expect(workflowRunIds(automation.threadId)).resolves.toStrictEqual([
      firstRunId,
    ]);
  });

  it("finishes required queue persistence when the request aborts during encryption", async () => {
    const scenario = await setup();
    const automation = await createWebhookAutomation(scenario);
    const firstRunId = await expectAcceptedRunId(
      await postWorkflowWebhook(automation, "first"),
      automation.threadId,
    );

    const kmsStarted = createDeferredPromise<void>(context.signal);
    const releaseKms = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!kmsStarted.settled()) {
        kmsStarted.resolve(undefined);
      }
      if (!releaseKms.settled()) {
        releaseKms.resolve(undefined);
      }
    });
    async function encryptAfterRelease(
      command: GenerateDataKeyCommand,
    ): Promise<GenerateDataKeyCommandOutput> {
      await releaseKms.promise;
      return generateDataKeyOutput(command);
    }
    const kms = useSecretKmsProbe((command, callNumber) => {
      if (callNumber !== 1) {
        return undefined;
      }
      kmsStarted.resolve(undefined);
      return encryptAfterRelease(command);
    });

    const requestController = new AbortController();
    const secondRequest = postWorkflowWebhook(
      automation,
      "second",
      requestController.signal,
    );
    await kmsStarted.promise;
    const abortError = new Error("request aborted during queue encryption");
    abortError.name = "AbortError";
    requestController.abort(abortError);
    releaseKms.resolve(undefined);

    await expect(secondRequest).resolves.toStrictEqual({
      status: 500,
      body: { error: "Internal server error" },
    });
    expect(kms.generateDataKeyCalls).toBe(1);

    await completeRunThroughSandbox(scenario, firstRunId);
    await expect(workflowRunIds(automation.threadId)).resolves.toHaveLength(2);
  });

  it("requires queue persistence even when encryption finishes after the thread becomes idle", async () => {
    const scenario = await setup();
    const automation = await createWebhookAutomation(scenario);
    const firstRunId = await expectAcceptedRunId(
      await postWorkflowWebhook(automation, "first"),
      automation.threadId,
    );

    const kmsStarted = createDeferredPromise<void>(context.signal);
    const releaseKms = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!kmsStarted.settled()) {
        kmsStarted.resolve(undefined);
      }
      if (!releaseKms.settled()) {
        releaseKms.resolve(undefined);
      }
    });
    async function failKmsAfterRelease(): Promise<GenerateDataKeyCommandOutput> {
      await releaseKms.promise;
      throw new Error("queue payload encryption failed");
    }
    const kms = useSecretKmsProbe((_command, callNumber) => {
      if (callNumber !== 1) {
        return undefined;
      }
      kmsStarted.resolve(undefined);
      return failKmsAfterRelease();
    });

    const secondRequest = postWorkflowWebhook(automation, "second");
    await kmsStarted.promise;
    expect(kms.generateDataKeyCalls).toBe(1);
    await completeRunThroughSandbox(scenario, firstRunId);
    releaseKms.resolve(undefined);

    await expect(secondRequest).resolves.toStrictEqual({
      status: 500,
      body: { error: "Internal server error" },
    });
    expect(kms.generateDataKeyCalls).toBe(1);
    await expect(workflowRunIds(automation.threadId)).resolves.toStrictEqual([
      firstRunId,
    ]);
  });

  it("rejects only the failed webhook trigger and accepts the next event", async () => {
    const scenario = await setup();
    const automation = await createWebhookAutomation(scenario);
    mockNow(Date.UTC(2026, 6, 25, 12));
    await accept(
      modelProvidersByTypeClient().delete({
        headers: authHeaders(),
        params: { type: "anthropic-api-key" },
      }),
      [204],
    );

    await expect(
      postWorkflowWebhook(automation, "fast-failed launch"),
    ).resolves.toStrictEqual({
      status: 500,
      body: { error: "Failed to start webhook workflow run" },
    });

    await expect(
      pendingWorkflowEvents(automation.threadId),
    ).resolves.toHaveLength(0);
    const failedEvents = await accept(
      chatThreadEventsClient().list({
        headers: authHeaders(),
        params: { threadId: automation.threadId },
        query: {},
      }),
      [200],
    );
    expect(failedEvents.body.events).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "input.rejected",
          error: expect.any(String),
          userMessage: {
            version: 1,
            parts: [
              {
                type: "automation",
                workflowName: WORKFLOW_NAME,
                workflowId: scenario.workflowId,
              },
            ],
          },
        }),
      ]),
    );
    const rejectedEvent = failedEvents.body.events.find((event) => {
      return event.eventType === "input.rejected";
    });
    expect(rejectedEvent).toStrictEqual(
      expect.objectContaining({
        userMessage: {
          version: 1,
          parts: [
            {
              type: "automation",
              workflowName: WORKFLOW_NAME,
              workflowId: scenario.workflowId,
            },
          ],
        },
      }),
    );
    if (!rejectedEvent?.revokesEventId) {
      throw new Error("Expected the rejected event to revoke its queue input");
    }
    await expect(
      readChatEventInputParamsFixture(rejectedEvent.revokesEventId),
    ).resolves.toBeNull();

    await runsApi.ensureOrgModelProvider(scenario.actor);
    const runId = await expectAcceptedRunId(
      await postWorkflowWebhook(automation, "next trigger"),
      automation.threadId,
    );
    await expect(workflowRunIds(automation.threadId)).resolves.toStrictEqual([
      runId,
    ]);
  });

  it("re-arms a recurring schedule after its launch fast-fails", async () => {
    mockNow(Date.UTC(2020, 0, 1));
    const scenario = await setup();
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: { schedule: { type: "loop", intervalSeconds: 3600 } },
      }),
      [201],
    );
    if (!created.body.chatThreadId || !created.body.nextRunAt) {
      throw new Error("Expected a thread-bound loop automation");
    }
    await accept(
      modelProvidersByTypeClient().delete({
        headers: authHeaders(),
        params: { type: "anthropic-api-key" },
      }),
      [204],
    );

    mockNow(Date.parse(created.body.nextRunAt) + 60_000);
    await executeDueWorkflowAutomations();
    await executeDueWorkflowAutomations();

    const automation = await wf.readAutomation(created.body.id);
    expect(automation.nextRunAt).not.toBeNull();
    await expect(
      pendingWorkflowEvents(created.body.chatThreadId),
    ).resolves.toHaveLength(0);

    await runsApi.ensureOrgModelProvider(scenario.actor);

    if (!automation.nextRunAt) {
      throw new Error("Expected the failed recurring schedule to re-arm");
    }
    mockNow(Date.parse(automation.nextRunAt) + 60_000);
    await executeDueWorkflowAutomations();
    await expect(
      workflowRunIds(created.body.chatThreadId),
    ).resolves.toHaveLength(1);
  });

  it("drains a queued one-time event through the canonical session", async () => {
    mockNow(Date.UTC(2020, 0, 1));
    const scenario = await setup();
    const webhookAutomation = await createWebhookAutomation(scenario);
    const busyRunId = await expectAcceptedRunId(
      await postWorkflowWebhook(webhookAutomation, "busy"),
      webhookAutomation.threadId,
    );
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
    if (!created.body.chatThreadId || !created.body.nextRunAt) {
      throw new Error("Expected a thread-bound one-time automation");
    }
    expect(created.body.chatThreadId).toBe(webhookAutomation.threadId);

    mockNow(Date.parse(created.body.nextRunAt) + 60_000);
    await executeDueWorkflowAutomations();
    const claimed = await wf.readAutomation(created.body.id);
    expect(claimed.enabled).toBeTruthy();
    expect(claimed.nextRunAt).toBeNull();

    const queuedEvent = await pendingWorkflowEventForAutomation(
      created.body.chatThreadId,
      created.body.id,
    );
    if (!queuedEvent) {
      throw new Error("Expected the claimed one-time event to remain queued");
    }

    const busyBinding = await readThreadSessionBinding(
      context,
      created.body.chatThreadId,
    );
    if (!busyBinding.agent_session_id) {
      throw new Error("Expected the busy run to bind the thread session");
    }
    await completeRunThroughSandbox(scenario, busyRunId);
    const runIds = await workflowRunIds(created.body.chatThreadId);
    expect(runIds).toHaveLength(2);
    const drainedRunId = runIds[1];
    if (!drainedRunId) {
      throw new Error("Expected the queued one-time event to drain");
    }
    const drainedBinding = await readThreadSessionBinding(
      context,
      created.body.chatThreadId,
    );
    expect(drainedBinding).toMatchObject({
      agent_session_id: busyBinding.agent_session_id,
      agent_session_run_id: drainedRunId,
      run_session_id: busyBinding.agent_session_id,
    });
    const drainedClaim = await completeRunThroughSandbox(
      scenario,
      drainedRunId,
    );
    expect(drainedClaim.resumeSession?.sessionId).toBe(
      `workflow-queue-cli-${busyRunId}`,
    );
    const drained = await wf.readAutomation(created.body.id);
    expect(drained.enabled).toBeFalsy();
    expect(drained.nextRunAt).toBeNull();
  });

  it("drains user chat before workflow events in one canonical session", async () => {
    const scenario = await setup();
    const automation = await createWebhookAutomation(scenario);
    // The queued-message auto-send runs inside the terminal chat callback,
    // which needs the run's assistant output (Axiom) and session-history
    // blobs (S3) to resolve.
    chatCallbacks.mockChatOutputEvents([
      {
        eventType: "assistant",
        sequenceNumber: 0,
        eventData: { message: { content: [{ type: "text", text: "done" }] } },
      },
    ]);
    chatCallbacks.acceptChatObjectStorage();

    const firstRunId = await expectAcceptedRunId(
      await postWorkflowWebhook(automation, "first"),
      automation.threadId,
    );
    const firstBinding = await readThreadSessionBinding(
      context,
      automation.threadId,
    );
    if (!firstBinding.agent_session_id) {
      throw new Error("Expected the first workflow run to bind the session");
    }
    expectAcceptedWithoutRun(await postWorkflowWebhook(automation, "second"));

    // A user message sent while the automation run is active joins the chat
    // message queue (no run yet).
    const queued = await accept(
      chatEventsClient().send({
        headers: authHeaders(),
        body: {
          agentId: scenario.agentId,
          threadId: automation.threadId,
          prompt: "user interjection",
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "user interjection" }],
          },
        },
      }),
      [201],
    );
    expect(queued.body.runId).toBeNull();

    // Terminal run: the user message drains first, the workflow event waits.
    await completeRunThroughSandbox(scenario, firstRunId);
    await expect(workflowRunIds(automation.threadId)).resolves.toHaveLength(1);
    const messages = await wf.readThreadEvents(automation.threadId);
    const userMessage = messages.find((message) => {
      return (
        chatEventDisplayText(message) === "user interjection" &&
        typeof message.runId === "string"
      );
    });
    if (!userMessage?.runId) {
      throw new Error("Expected the queued user message to claim a run");
    }
    const userBinding = await readThreadSessionBinding(
      context,
      automation.threadId,
    );
    expect(userBinding).toMatchObject({
      agent_session_id: firstBinding.agent_session_id,
      agent_session_run_id: userMessage.runId,
      run_session_id: firstBinding.agent_session_id,
    });

    // The workflow event drains only after the user's run finishes.
    const userClaim = await completeRunThroughSandbox(
      scenario,
      userMessage.runId,
    );
    expect(userClaim.resumeSession?.sessionId).toBe(
      `workflow-queue-cli-${firstRunId}`,
    );
    const runIds = await workflowRunIds(automation.threadId);
    expect(runIds).toHaveLength(2);
    const secondWorkflowRunId = runIds[1];
    if (!secondWorkflowRunId) {
      throw new Error("Expected the queued workflow event to drain");
    }
    const workflowBinding = await readThreadSessionBinding(
      context,
      automation.threadId,
    );
    expect(workflowBinding).toMatchObject({
      agent_session_id: firstBinding.agent_session_id,
      agent_session_run_id: secondWorkflowRunId,
      run_session_id: firstBinding.agent_session_id,
    });
    const workflowClaim = await completeRunThroughSandbox(
      scenario,
      secondWorkflowRunId,
    );
    expect(workflowClaim.resumeSession?.sessionId).toBe(
      `workflow-queue-cli-${userMessage.runId}`,
    );
  });

  it("serializes competing admissions into one canonical session", async () => {
    const scenario = await setup();
    const automation = await createWebhookAutomation(scenario);
    chatCallbacks.mockChatOutputEvents([
      {
        eventType: "assistant",
        sequenceNumber: 0,
        eventData: { message: { content: [{ type: "text", text: "done" }] } },
      },
    ]);
    chatCallbacks.acceptChatObjectStorage();

    const admissionLock = await holdOrgAdmissionLockFixture({
      orgId: scenario.orgId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      admissionLock.release();
      await admissionLock.done;
    });

    const workflowRequest = postWorkflowWebhook(automation, "workflow first");
    await expect.poll(admissionLock.waiterCount).toBe(1);

    const userRequest = chatEventsClient().send({
      headers: authHeaders(),
      body: {
        agentId: scenario.agentId,
        threadId: automation.threadId,
        prompt: "user wins final admission",
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: "user wins final admission" }],
        },
      },
    });
    await expect
      .poll(async () => {
        const messages = await wf.readThreadEvents(automation.threadId);
        return messages.some((message) => {
          return chatEventDisplayText(message) === "user wins final admission";
        });
      })
      .toBe(true);
    await expect.poll(admissionLock.waiterCount).toBe(2);

    admissionLock.release();
    const [workflowResult, userResult] = await Promise.all([
      workflowRequest,
      accept(userRequest, [201]),
    ]);
    await admissionLock.done;

    expectAcceptedWithoutRun(workflowResult);
    if (!userResult.body.runId) {
      throw new Error("Expected the user message to win final admission");
    }
    await expect(workflowRunIds(automation.threadId)).resolves.toHaveLength(0);
    const userBinding = await readThreadSessionBinding(
      context,
      automation.threadId,
    );
    if (!userBinding.agent_session_id) {
      throw new Error("Expected the winning user run to bind the session");
    }
    expect(userBinding).toMatchObject({
      agent_session_run_id: userResult.body.runId,
      run_session_id: userBinding.agent_session_id,
    });

    await completeRunThroughSandbox(scenario, userResult.body.runId);
    const [workflowRunId] = await workflowRunIds(automation.threadId);
    if (!workflowRunId) {
      throw new Error("Expected the competing workflow event to drain");
    }
    const workflowBinding = await readThreadSessionBinding(
      context,
      automation.threadId,
    );
    expect(workflowBinding).toMatchObject({
      agent_session_id: userBinding.agent_session_id,
      agent_session_run_id: workflowRunId,
      run_session_id: userBinding.agent_session_id,
    });
    const workflowClaim = await completeRunThroughSandbox(
      scenario,
      workflowRunId,
    );
    expect(workflowClaim.resumeSession?.sessionId).toBe(
      `workflow-queue-cli-${userResult.body.runId}`,
    );
  });
});
