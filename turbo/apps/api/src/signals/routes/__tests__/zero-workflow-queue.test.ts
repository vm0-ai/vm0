import { createHash, randomUUID } from "node:crypto";

import {
  DecryptCommand,
  type DecryptCommandOutput,
  GenerateDataKeyCommand,
  type GenerateDataKeyCommandOutput,
} from "@aws-sdk/client-kms";
import { chatMessagesContract } from "@vm0/api-contracts/contracts/chat-threads";
import { zeroModelProvidersByTypeContract } from "@vm0/api-contracts/contracts/zero-model-providers";
import { zeroWorkflowQueueContract } from "@vm0/api-contracts/contracts/zero-workflow-queue";
import { zeroWorkflowAutomationsContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { onTestFinished } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import {
  setSecretKmsClientForTests,
  type SecretKmsClient,
} from "../../../lib/secret-kms-client";
import { mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import {
  completeRunWithoutCallbacksFixture,
  holdOrgAdmissionLockFixture,
  rewriteWorkflowQueueEventAsPreviousVersionFixture,
  setQueuedUserMessageCreatedAtFixture,
  setWorkflowQueueEventCreatedAtFixture,
} from "../../../test-fixtures/chat-messages";

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
const TEST_DATA_KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

interface SecretKmsProbe {
  readonly generateDataKeyCalls: number;
}

function generateDataKeyOutput(
  command: GenerateDataKeyCommand,
): GenerateDataKeyCommandOutput {
  return {
    $metadata: {},
    KeyId: command.input.KeyId,
    CiphertextBlob: Buffer.from(
      `encrypted-data-key:${command.input.KeyId}`,
      "utf8",
    ),
    Plaintext: TEST_DATA_KEY,
  };
}

function useSecretKmsProbe(
  overrideGenerateDataKey?: (
    command: GenerateDataKeyCommand,
    callNumber: number,
  ) => Promise<GenerateDataKeyCommandOutput> | undefined,
): SecretKmsProbe {
  let generateDataKeyCalls = 0;

  function send(
    command: GenerateDataKeyCommand,
  ): Promise<GenerateDataKeyCommandOutput>;
  function send(command: DecryptCommand): Promise<DecryptCommandOutput>;
  function send(
    command: GenerateDataKeyCommand | DecryptCommand,
  ): Promise<GenerateDataKeyCommandOutput | DecryptCommandOutput> {
    if (command instanceof GenerateDataKeyCommand) {
      generateDataKeyCalls += 1;
      const overridden = overrideGenerateDataKey?.(
        command,
        generateDataKeyCalls,
      );
      return overridden ?? Promise.resolve(generateDataKeyOutput(command));
    }

    return Promise.resolve({ $metadata: {}, Plaintext: TEST_DATA_KEY });
  }

  const client: SecretKmsClient = { send };
  setSecretKmsClientForTests(client);
  return {
    get generateDataKeyCalls() {
      return generateDataKeyCalls;
    },
  };
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function automationsClient() {
  return setupApp({ context })(zeroWorkflowAutomationsContract);
}

function chatMessagesClient() {
  return setupApp({ context })(chatMessagesContract);
}

function queueClient() {
  return setupApp({ context })(zeroWorkflowQueueContract);
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
  context.mocks.s3.send.mockResolvedValue({});
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

async function completeRunThroughSandbox(scenario: Scenario, runId: string) {
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

describe("workflow queue", () => {
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
    await expect.poll(admissionLock.waiterCount).toBe(1);

    await cleanupSandboxes();
    await expect(admissionLock.waiterCount()).resolves.toBe(1);

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
    const queued = await accept(
      queueClient().get({
        headers: authHeaders(),
        params: { threadId: automation.threadId },
      }),
      [200],
    );
    const event = queued.body.pending[0];
    if (!event) {
      throw new Error("Expected a pending workflow event");
    }
    await setWorkflowQueueEventCreatedAtFixture({
      eventId: event.id,
      createdAt: new Date("2019-12-31T23:54:00.000Z"),
    });

    const userRequest = chatMessagesClient().send({
      headers: authHeaders(),
      body: {
        agentId: scenario.agentId,
        threadId: automation.threadId,
        prompt: "fresh user message",
      },
    });
    // The persisted queued message is the product milestone proving the send
    // reached the queue; the waiter count is a cluster-wide `pg_locks`
    // observation of one org key that several admission attempts share, so it
    // is only used as a lower-bound barrier here.
    await expect
      .poll(async () => {
        const messages = await wf.readThreadMessages(automation.threadId);
        return messages.some((message) => {
          return message.content === "fresh user message";
        });
      })
      .toBe(true);
    await expect.poll(admissionLock.waiterCount).toBeGreaterThanOrEqual(2);
    const admittedWaiters = await admissionLock.waiterCount();

    // The business assertion: the stale sweep must not add an admission
    // attempt of its own for this org, so the waiter count stays exactly where
    // both blocked requests left it.
    await cleanupSandboxes();
    await expect(admissionLock.waiterCount()).resolves.toBe(admittedWaiters);

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
    const queued = await accept(
      queueClient().get({
        headers: authHeaders(),
        params: { threadId: automation.threadId },
      }),
      [200],
    );
    const event = queued.body.pending[0];
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

    const recovered = await accept(
      queueClient().get({
        headers: authHeaders(),
        params: { threadId: automation.threadId },
      }),
      [200],
    );
    expect(recovered.body.pending).toHaveLength(0);
    expect(recovered.body.running?.runId).toStrictEqual(expect.any(String));
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
      chatMessagesClient().send({
        headers: authHeaders(),
        body: {
          agentId: scenario.agentId,
          threadId: automation.threadId,
          prompt: "stale user message",
          clientMessageId: messageId,
        },
      }),
      [201],
    );
    expect(queued.body.runId).toBeNull();
    await setQueuedUserMessageCreatedAtFixture({
      messageId,
      createdAt: new Date("2019-12-31T23:54:00.000Z"),
    });

    await runsApi.heartbeatRunner(scenario.runnerGroup);
    await runsApi.claimRunnerJob(firstRunId);
    await completeRunWithoutCallbacksFixture({ runId: firstRunId });

    await cleanupSandboxes();

    const messages = await wf.readThreadMessages(automation.threadId);
    expect(messages).toContainEqual(
      expect.objectContaining({
        content: "stale user message",
        revokesMessageId: messageId,
        runId: expect.any(String),
      }),
    );
  });

  it("queues webhook events behind the active run and drains one per completion", async () => {
    const scenario = await setup();
    const automation = await createWebhookAutomation(scenario);
    const kms = useSecretKmsProbe();

    const first = await postWorkflowWebhook(automation, "first");
    const firstRunId = await expectAcceptedRunId(first, automation.threadId);
    // Every workflow event is encrypted before admission; the launched run
    // then uses a second data key for runner execution secrets.
    expect(kms.generateDataKeyCalls).toBe(2);

    // The workflow is busy: the next two events are accepted into the queue
    // without creating runs.
    const secondApiStartTime = now() + 60_000;
    mockNow(secondApiStartTime);
    expectAcceptedWithoutRun(await postWorkflowWebhook(automation, "second"));
    expect(kms.generateDataKeyCalls).toBe(3);
    mockNow(secondApiStartTime + 1000);
    expectAcceptedWithoutRun(await postWorkflowWebhook(automation, "third"));
    expect(kms.generateDataKeyCalls).toBe(4);
    await expect(workflowRunIds(automation.threadId)).resolves.toStrictEqual([
      firstRunId,
    ]);

    // Completing the run drains exactly one event into the next run.
    const dequeuedAt = secondApiStartTime + 10_000;
    mockNow(dequeuedAt);
    await completeRunThroughSandbox(scenario, firstRunId);
    const afterFirst = await workflowRunIds(automation.threadId);
    expect(afterFirst).toHaveLength(2);
    const secondClaim = await completeRunThroughSandbox(
      scenario,
      afterFirst[1]!,
    );
    expect(secondClaim.apiStartTime).toBe(dequeuedAt);
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
    expect(kms.generateDataKeyCalls).toBe(2);

    // Two due ticks while busy: the second coalesces into the pending one.
    mockNow(Date.parse(created.body.nextRunAt) + 60_000);
    await executeDueWorkflowAutomations();
    expect(kms.generateDataKeyCalls).toBe(3);
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

    await completeRunThroughSandbox(scenario, busyRunId);
    const afterBusy = await workflowRunIds(webhookAutomation.threadId);
    expect(afterBusy).toHaveLength(2);

    // Only the single coalesced tick ran; nothing else is queued.
    await completeRunThroughSandbox(scenario, afterBusy[1]!);
    await expect(
      workflowRunIds(webhookAutomation.threadId),
    ).resolves.toHaveLength(2);
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

  it("keeps a failed webhook event accepted without duplicating its retained queue item", async () => {
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

    expectAcceptedWithoutRun(
      await postWorkflowWebhook(automation, "retained launch failure"),
    );
    await expect(
      postWorkflowWebhook(automation, "retained launch failure"),
    ).resolves.toStrictEqual({
      status: 200,
      body: { success: true, duplicate: true },
    });

    const paused = await accept(
      queueClient().get({
        headers: authHeaders(),
        params: { threadId: automation.threadId },
      }),
      [200],
    );
    expect(paused.body.running).toBeNull();
    expect(paused.body.pausedAt).not.toBeNull();
    expect(paused.body.pauseReason).not.toBeNull();
    expect(
      paused.body.pending.map((event) => {
        return event.automationId;
      }),
    ).toStrictEqual([automation.automationId]);

    await runsApi.ensureOrgModelProvider(scenario.actor);
    const resumed = await accept(
      queueClient().resume({
        headers: authHeaders(),
        params: { threadId: automation.threadId },
      }),
      [200],
    );
    expect(resumed.body.pausedAt).toBeNull();
    expect(resumed.body.pending).toHaveLength(0);
    const running = resumed.body.running;
    if (!running) {
      throw new Error("Expected the retained event to resume");
    }
    await expect(workflowRunIds(automation.threadId)).resolves.toStrictEqual([
      running.runId,
    ]);
  });

  it("does not re-arm a schedule whose failed launch remains queued", async () => {
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
    expect(automation.nextRunAt).toBeNull();
    const paused = await accept(
      queueClient().get({
        headers: authHeaders(),
        params: { threadId: created.body.chatThreadId },
      }),
      [200],
    );
    expect(paused.body.running).toBeNull();
    expect(paused.body.pausedAt).not.toBeNull();
    expect(
      paused.body.pending.map((event) => {
        return event.automationId;
      }),
    ).toStrictEqual([created.body.id]);

    await runsApi.ensureOrgModelProvider(scenario.actor);
    const resumed = await accept(
      queueClient().resume({
        headers: authHeaders(),
        params: { threadId: created.body.chatThreadId },
      }),
      [200],
    );
    expect(resumed.body.pending).toHaveLength(0);
    expect(resumed.body.running?.runId).toStrictEqual(expect.any(String));
  });

  it("drains a previous-version queued one-time event during rollout", async () => {
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

    const queued = await accept(
      queueClient().get({
        headers: authHeaders(),
        params: { threadId: created.body.chatThreadId },
      }),
      [200],
    );
    const previousEvent = queued.body.pending.find((event) => {
      return event.automationId === created.body.id;
    });
    if (!previousEvent) {
      throw new Error("Expected the claimed one-time event to remain queued");
    }
    await rewriteWorkflowQueueEventAsPreviousVersionFixture({
      eventId: previousEvent.id,
      automationId: created.body.id,
    });

    await completeRunThroughSandbox(scenario, busyRunId);
    const runIds = await workflowRunIds(created.body.chatThreadId);
    expect(runIds).toHaveLength(2);
    const drained = await wf.readAutomation(created.body.id);
    expect(drained.enabled).toBeFalsy();
    expect(drained.nextRunAt).toBeNull();
  });

  it("drains queued user chat messages before workflow events", async () => {
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

  it("keeps the workflow event queued when a user message wins final admission", async () => {
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

    const userRequest = chatMessagesClient().send({
      headers: authHeaders(),
      body: {
        agentId: scenario.agentId,
        threadId: automation.threadId,
        prompt: "user wins final admission",
      },
    });
    await expect
      .poll(async () => {
        const messages = await wf.readThreadMessages(automation.threadId);
        return messages.some((message) => {
          return message.content === "user wins final admission";
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

    await completeRunThroughSandbox(scenario, userResult.body.runId);
    await expect(workflowRunIds(automation.threadId)).resolves.toHaveLength(1);
  });
});
