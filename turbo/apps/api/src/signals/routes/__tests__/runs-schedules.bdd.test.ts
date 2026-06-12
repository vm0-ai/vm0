import { createHash, randomUUID } from "node:crypto";

import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { emailOutbox } from "@vm0/db/schema/email-outbox";
import { emailSuppressions } from "@vm0/db/schema/email-suppression";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { describe, expect, it, onTestFinished } from "vitest";

import { clearMockNow, mockNow, now } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-helpers";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import { settle } from "../../utils";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createEmailApi } from "./helpers/api-bdd-email";
import { createFirewallApi } from "./helpers/api-bdd-firewall";
import {
  createRunsSchedulesApi,
  uniqueScheduleName,
} from "./helpers/api-bdd-runs-schedules";
import {
  callbackDeliveryWithStatus,
  createWebhookCallbackApi,
} from "./helpers/api-bdd-webhooks";

/**
 * helper gap:
 * - RUN-02 exhaustive connector credential, secret, variable, grant, custom
 *   connector, and skill setup still needs public API helper coverage before
 *   the old DB fixture matrix can be ported without DB writes. This file covers
 *   model-provider setup through API routes and run-context GET boundaries.
 * - RUN-01/RUN-03/CHAIN-RUN successful dispatch is covered by
 *   run-lifecycle.bdd.test.ts via the public Stripe invoice.paid entitlement
 *   helper (grantProEntitlement); this file keeps the unauthenticated and
 *   malformed admission boundaries plus runner auth surfaces.
 * - RUN-04 persisted runner log ingestion needs callback/event API helpers.
 *   Checkpoint creation through the sandbox webhook is covered by
 *   run-lifecycle.bdd.test.ts; missing-run GET boundaries stay here.
 * - SCHED-01 has no standalone read-by-name route; schedule list is used as
 *   the visible read surface for create, update, enable, disable, and delete.
 * - CHAIN-SCHEDULE cron execution returns global counts only and does not
 *   expose created run ids; run identity is read through the org run queue
 *   (queued runs) and the schedule thread's user messages (executed runs),
 *   which expose the runId. Cron count fields are never asserted strictly
 *   because the cron processes due schedules across all organizations.
 * - SCHED-02 sync-skills valid-path coverage needs a focused external GitHub
 *   tarball/S3 helper; this file keeps cron auth and safe no-work cron routes
 *   route-based without adding that external fixture.
 */

const context = testContext();
const store = createStore();
const writeDb = store.set(writeDb$);
const OUTBOX_TEST_FROM = "Zero <bdd-outbox@mail.example.com>";
const OUTBOX_TEST_CREATED_AT_OFFSET_MS = 10 * 60 * 1000;

interface SeedEmailOutboxOptions {
  readonly subject: string;
  readonly to: string;
  readonly status?: string;
  readonly attempts?: number;
  readonly createdAt?: Date;
  readonly nextRetryAt?: Date | null;
}

async function seedEmailOutbox(options: SeedEmailOutboxOptions): Promise<void> {
  await writeDb.insert(emailOutbox).values({
    fromAddress: OUTBOX_TEST_FROM,
    toAddresses: options.to,
    subject: `Re: ${options.subject}`,
    template: {
      template: "inbound-error",
      props: { errorMessage: "BDD outbox test email" },
    },
    status: options.status ?? "pending",
    attempts: options.attempts ?? 0,
    createdAt:
      options.createdAt ?? new Date(now() - OUTBOX_TEST_CREATED_AT_OFFSET_MS),
    nextRetryAt: options.nextRetryAt ?? null,
  });

  onTestFinished(async () => {
    await writeDb
      .delete(emailOutbox)
      .where(eq(emailOutbox.subject, `Re: ${options.subject}`));
  });
}

async function seedEmailSuppression(address: string): Promise<void> {
  await writeDb.insert(emailSuppressions).values({
    emailAddress: address,
    reason: "bounced",
    resendEmailId: `em_${randomUUID()}`,
  });

  onTestFinished(async () => {
    await writeDb
      .delete(emailSuppressions)
      .where(eq(emailSuppressions.emailAddress, address));
  });
}

function resendSendCallsTo(recipient: string): number {
  return context.mocks.resend.send.mock.calls.filter((call) => {
    const [payload] = call;
    if (typeof payload !== "object" || payload === null || !("to" in payload)) {
      return false;
    }

    const to = payload.to;
    if (typeof to === "string") {
      return to === recipient;
    }
    return Array.isArray(to) && to.includes(recipient);
  }).length;
}

async function touchEmailOutbox(subject: string): Promise<void> {
  const updated = await writeDb
    .update(emailOutbox)
    .set({ createdAt: new Date(now()) })
    .where(eq(emailOutbox.subject, `Re: ${subject}`))
    .returning({ id: emailOutbox.id });

  if (updated.length === 0) {
    throw new Error(`Expected email outbox row for ${subject} to touch`);
  }
}

async function emailOutboxStatus(subject: string): Promise<string | null> {
  const [row] = await writeDb
    .select({ status: emailOutbox.status })
    .from(emailOutbox)
    .where(eq(emailOutbox.subject, `Re: ${subject}`))
    .limit(1);

  return row?.status ?? null;
}

async function emailOutboxRow(subject: string): Promise<{
  readonly status: string;
  readonly attempts: number;
  readonly lastError: string | null;
} | null> {
  const [row] = await writeDb
    .select({
      status: emailOutbox.status,
      attempts: emailOutbox.attempts,
      lastError: emailOutbox.lastError,
    })
    .from(emailOutbox)
    .where(eq(emailOutbox.subject, `Re: ${subject}`))
    .limit(1);

  return row ?? null;
}

async function drainEmailOutboxCronOk(): Promise<void> {
  const email = createEmailApi(context);
  context.mocks.resend.send.mockResolvedValue({
    data: { id: `resend-bdd-drain-${randomUUID()}` },
  });
  const drain = await email.drainEmailOutboxCron(true);
  if (drain.status !== 200) {
    throw new Error("Expected drain email outbox cron to succeed");
  }
}

async function createAgentWithModelProvider(actor: ApiTestUser): Promise<{
  readonly agentId: string;
}> {
  const bdd = createBddApi(context);
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "BDD run agent",
    description: "Exercises run and schedule API integration tests.",
    visibility: "private",
  });

  const api = createRunsSchedulesApi(context);
  await api.ensureOrgModelProvider(actor);

  return { agentId: agent.agentId };
}

function findSchedule<
  TSchedule extends { readonly id: string; readonly name: string },
>(schedules: readonly TSchedule[], scheduleId: string): TSchedule | undefined {
  return schedules.find((schedule) => {
    return schedule.id === scheduleId;
  });
}

function mustFindSchedule<
  TSchedule extends { readonly id: string; readonly name: string },
>(schedules: readonly TSchedule[], scheduleId: string): TSchedule {
  const schedule = findSchedule(schedules, scheduleId);
  if (!schedule) {
    throw new Error(`Expected schedule ${scheduleId} to be visible in list`);
  }
  return schedule;
}

async function entitledScheduleActor(): Promise<{
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
}> {
  const bdd = createBddApi(context);
  const api = createRunsSchedulesApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "BDD schedule agent",
    description: "Exercises cron execution of due schedules.",
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, runnerGroup };
}

async function executeSchedulesCronOk(): Promise<void> {
  const response =
    await createRunsSchedulesApi(context).executeSchedulesCron(true);
  if (response.status !== 200) {
    throw new Error("Expected execute schedules cron to succeed");
  }
  expect(response.body.success).toBeTruthy();
}

interface ThreadMessageView {
  readonly role: "user" | "assistant";
  readonly content: string | null;
  readonly runId?: string;
}

const QUEUE_MARKER_MESSAGE = "Waiting in queue...";

function scheduleUserMessages(
  messages: readonly ThreadMessageView[],
  prompt: string,
): readonly ThreadMessageView[] {
  return messages.filter((message) => {
    return message.role === "user" && message.content === prompt;
  });
}

function scheduleRunIdFromThread(
  messages: readonly ThreadMessageView[],
  prompt: string,
): string {
  const runId = scheduleUserMessages(messages, prompt)[0]?.runId;
  if (!runId) {
    throw new Error("Expected a schedule user message carrying a runId");
  }
  return runId;
}

function hasQueueMarker(
  messages: readonly ThreadMessageView[],
  runId: string,
): boolean {
  return messages.some((message) => {
    return (
      message.role === "assistant" &&
      message.runId === runId &&
      message.content === QUEUE_MARKER_MESSAGE
    );
  });
}

function zeroToken(
  actor: ApiTestUser,
  capabilities: readonly ZeroCapability[],
) {
  if (!actor.orgId) {
    throw new Error("Zero tokens require an org-scoped actor");
  }
  const timestamp = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "zero",
    userId: actor.userId,
    orgId: actor.orgId,
    runId: randomUUID(),
    capabilities: [...capabilities],
    iat: timestamp,
    exp: timestamp + 60,
  });
}

describe("RUN-01: run creation admission and validation", () => {
  it("rejects invalid or unauthorized run creation requests through API validation", async () => {
    const bdd = createBddApi(context);
    const api = createRunsSchedulesApi(context);
    const actor = bdd.user();

    const unauthenticated = await api.requestCreateRun(
      null,
      {
        agentId: randomUUID(),
        prompt: "summarize the repo",
        modelProvider: "anthropic-api-key",
      },
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const missingAgent = await api.requestCreateRunUnchecked(
      actor,
      { prompt: "summarize the repo" },
      [400],
    );
    expectApiError(missingAgent.body);
    expect(missingAgent.body.error.code).toBe("BAD_REQUEST");

    const invalidTools = await api.requestCreateRun(
      actor,
      {
        agentId: randomUUID(),
        prompt: "use a malformed tool list",
        tools: ["Bash,Read"],
        modelProvider: "anthropic-api-key",
      },
      [400],
    );
    expectApiError(invalidTools.body);
    expect(invalidTools.body.error.code).toBe("BAD_REQUEST");

    const missingSession = await api.requestCreateRun(
      actor,
      {
        sessionId: randomUUID(),
        prompt: "resume a missing session",
        modelProvider: "anthropic-api-key",
      },
      [404],
    );
    expectApiError(missingSession.body);
    expect(missingSession.body.error.code).toBe("NOT_FOUND");

    const missingAgentId = await api.requestCreateRun(
      actor,
      {
        agentId: randomUUID(),
        prompt: "run a missing agent",
        modelProvider: "anthropic-api-key",
      },
      [404],
    );
    expectApiError(missingAgentId.body);
    expect(missingAgentId.body.error.code).toBe("NOT_FOUND");
  });
});

describe("RUN-01..04 and CHAIN-RUN: run admission, runner, and visible reads", () => {
  it("sets up run prerequisites through APIs and exposes the no-credit admission boundary", async () => {
    const bdd = createBddApi(context);
    const api = createRunsSchedulesApi(context);
    const actor = bdd.user();
    const { agentId } = await createAgentWithModelProvider(actor);

    const denied = await api.requestCreateRun(
      actor,
      {
        agentId,
        prompt: "Produce a concise status report.",
        modelProvider: "anthropic-api-key",
        tools: ["Bash"],
        settings: "{}",
      },
      [402],
    );
    expectApiError(denied.body);
    expect(denied.body.error.code).toBe("INSUFFICIENT_CREDITS");

    const queue = await api.readRunQueue(actor);
    expect(queue.body.concurrency.active).toBe(0);
    expect(queue.body.queue).toHaveLength(0);

    const runnerGroup = api.configureRunnerGroup();
    const heartbeat = await api.heartbeatRunner(runnerGroup);
    expect(heartbeat.body.ok).toBeTruthy();

    const poll = await api.pollRunner(runnerGroup);
    expect(poll.body.job).toBeNull();

    const missingRunId = randomUUID();
    const missingRun = await api.requestReadRun(actor, missingRunId, [404]);
    expectApiError(missingRun.body);
    expect(missingRun.body.error.code).toBe("NOT_FOUND");

    const missingContext = await api.requestRunContext(
      actor,
      missingRunId,
      [404],
    );
    expectApiError(missingContext.body);
    expect(missingContext.body.error.code).toBe("NOT_FOUND");
  });

  it("keeps official runner held-session heartbeat and empty polling visible through public endpoints", async () => {
    const api = createRunsSchedulesApi(context);
    const runnerGroup = api.configureRunnerGroup();
    const heldSessionStates = [
      {
        sessionId: "session-bdd-held",
        lastCompletedAt: new Date(now()).toISOString(),
      },
    ];

    const heartbeat = await api.requestHeartbeatRunner(true, [200], {
      heldSessionStates,
    });
    if (heartbeat.status !== 200) {
      throw new Error(
        `Expected runner heartbeat to succeed, got ${heartbeat.status}`,
      );
    }
    expect(heartbeat.body.ok).toBeTruthy();

    const emptyWithoutProfiles = await api.requestPollRunner(
      true,
      { group: runnerGroup },
      [200],
    );
    if (emptyWithoutProfiles.status !== 200) {
      throw new Error(
        `Expected empty poll to succeed, got ${emptyWithoutProfiles.status}`,
      );
    }
    expect(emptyWithoutProfiles.body.job).toBeNull();

    const emptyHeldSessionPoll = await api.requestPollRunner(
      true,
      { group: runnerGroup, heldSessionStates },
      [200],
    );
    if (emptyHeldSessionPoll.status !== 200) {
      throw new Error(
        `Expected held-session poll to succeed, got ${emptyHeldSessionPoll.status}`,
      );
    }
    expect(emptyHeldSessionPoll.body.job).toBeNull();
  });

  it("keeps missing run detail and context hidden for another organization", async () => {
    const bdd = createBddApi(context);
    const api = createRunsSchedulesApi(context);
    const outsider = bdd.user();
    const missingRunId = randomUUID();

    const hiddenRun = await api.requestReadRun(outsider, missingRunId, [404]);
    expectApiError(hiddenRun.body);
    expect(hiddenRun.body.error.code).toBe("NOT_FOUND");

    const hiddenContext = await api.requestRunContext(
      outsider,
      missingRunId,
      [404],
    );
    expectApiError(hiddenContext.body);
    expect(hiddenContext.body.error.code).toBe("NOT_FOUND");
  });

  it("rejects runner metadata reads and job claims at unauthenticated, malformed, and missing boundaries", async () => {
    const bdd = createBddApi(context);
    const api = createRunsSchedulesApi(context);
    const actor = bdd.user();
    const missingRunId = randomUUID();
    const invalidRunId = "not-a-run-id";

    const unauthenticatedRunner = await api.requestRunRunner(
      null,
      missingRunId,
      [401],
    );
    expectApiError(unauthenticatedRunner.body);
    expect(unauthenticatedRunner.body.error.code).toBe("UNAUTHORIZED");

    const invalidRunner = await api.requestRunRunner(
      actor,
      invalidRunId,
      [400],
    );
    expectApiError(invalidRunner.body);
    expect(invalidRunner.body.error.code).toBe("BAD_REQUEST");

    const missingRunner = await api.requestRunRunner(
      actor,
      missingRunId,
      [404],
    );
    expectApiError(missingRunner.body);
    expect(missingRunner.body.error.code).toBe("NOT_FOUND");

    const unauthenticatedClaim = await api.requestClaimRunnerJob(
      false,
      missingRunId,
      [401],
    );
    expectApiError(unauthenticatedClaim.body);
    expect(unauthenticatedClaim.body.error.code).toBe("UNAUTHORIZED");

    const invalidClaim = await api.requestClaimRunnerJob(
      true,
      invalidRunId,
      [400],
    );
    expectApiError(invalidClaim.body);
    expect(invalidClaim.body.error.code).toBe("BAD_REQUEST");

    const missingClaim = await api.requestClaimRunnerJob(
      true,
      missingRunId,
      [404],
    );
    expectApiError(missingClaim.body);
    expect(missingClaim.body.error.code).toBe("NOT_FOUND");
  });

  it("rejects malformed and unauthenticated runner, queue, read, context, and cancel requests", async () => {
    const bdd = createBddApi(context);
    const api = createRunsSchedulesApi(context);
    const actor = bdd.user();
    const missingRunId = randomUUID();
    const invalidRunId = "not-a-run-id";

    const unauthenticatedQueue = await api.requestReadRunQueue(null, [401]);
    expectApiError(unauthenticatedQueue.body);
    expect(unauthenticatedQueue.body.error.code).toBe("UNAUTHORIZED");

    const unauthenticatedRead = await api.requestReadRun(
      null,
      missingRunId,
      [401],
    );
    expectApiError(unauthenticatedRead.body);
    expect(unauthenticatedRead.body.error.code).toBe("UNAUTHORIZED");

    const invalidRead = await api.requestReadRun(actor, invalidRunId, [400]);
    expectApiError(invalidRead.body);
    expect(invalidRead.body.error.code).toBe("BAD_REQUEST");

    const invalidContext = await api.requestRunContext(
      actor,
      invalidRunId,
      [400],
    );
    expectApiError(invalidContext.body);
    expect(invalidContext.body.error.code).toBe("BAD_REQUEST");

    const unauthenticatedCancel = await api.requestCancelRun(
      null,
      missingRunId,
      [401],
    );
    expectApiError(unauthenticatedCancel.body);
    expect(unauthenticatedCancel.body.error.code).toBe("UNAUTHORIZED");

    const invalidCancel = await api.requestCancelRun(
      actor,
      invalidRunId,
      [400],
    );
    expectApiError(invalidCancel.body);
    expect(invalidCancel.body.error.code).toBe("BAD_REQUEST");

    const missingCancel = await api.requestCancelRun(
      actor,
      missingRunId,
      [404],
    );
    expectApiError(missingCancel.body);
    expect(missingCancel.body.error.code).toBe("NOT_FOUND");

    const unauthenticatedHeartbeat = await api.requestHeartbeatRunner(
      false,
      [401],
    );
    expectApiError(unauthenticatedHeartbeat.body);
    expect(unauthenticatedHeartbeat.body.error.code).toBe("UNAUTHORIZED");

    const invalidHeartbeatGroup = await api.requestHeartbeatRunner(
      true,
      [400],
      { group: "other/test" },
    );
    expectApiError(invalidHeartbeatGroup.body);
    expect(invalidHeartbeatGroup.body.error.code).toBe("BAD_REQUEST");

    const unauthenticatedPoll = await api.requestPollRunner(
      false,
      { group: "vm0/test", profiles: ["vm0/default"] },
      [401],
    );
    expectApiError(unauthenticatedPoll.body);
    expect(unauthenticatedPoll.body.error.code).toBe("UNAUTHORIZED");

    const invalidPollGroup = await api.requestPollRunner(
      true,
      { group: "not-a-group", profiles: ["vm0/default"] },
      [400],
    );
    expectApiError(invalidPollGroup.body);
    expect(invalidPollGroup.body.error.code).toBe("BAD_REQUEST");
  });

  it("issues runner realtime tokens only for authenticated vm0 runner groups", async () => {
    const api = createRunsSchedulesApi(context);

    const unauthenticated = await api.requestRunnerRealtimeToken(
      false,
      { group: "vm0/test" },
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const malformedGroup = await api.requestRunnerRealtimeToken(
      true,
      { group: "not-a-group" },
      [400],
    );
    expectApiError(malformedGroup.body);
    expect(malformedGroup.body.error.code).toBe("BAD_REQUEST");

    const forbiddenGroup = await api.requestRunnerRealtimeToken(
      true,
      { group: "other/test" },
      [403],
    );
    expectApiError(forbiddenGroup.body);
    expect(forbiddenGroup.body.error.code).toBe("FORBIDDEN");

    const capability = JSON.stringify({
      "runner-group:vm0/test": ["subscribe"],
    });
    context.mocks.ably.createTokenRequest.mockResolvedValueOnce({
      keyName: "ably-key",
      timestamp: now(),
      capability,
      nonce: "nonce",
      mac: "mac",
    });

    const token = await api.requestRunnerRealtimeToken(
      true,
      { group: "vm0/test" },
      [200],
    );
    if (token.status !== 200) {
      throw new Error("Expected runner realtime token request to succeed");
    }
    expect(token.body.capability).toBe(capability);
    expect(context.mocks.ably.createTokenRequest).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.createTokenRequest).toHaveBeenCalledWith({
      capability: {
        "runner-group:vm0/test": ["subscribe"],
      },
      ttl: 60 * 60 * 1000,
    });
  });
});

describe("SCHED-01 and CHAIN-SCHEDULE: schedule lifecycle", () => {
  it("creates, lists, enables, reaches manual run admission, disables, and deletes a schedule", async () => {
    const bdd = createBddApi(context);
    const api = createRunsSchedulesApi(context);
    const actor = bdd.user();
    const outsider = bdd.user();
    const { agentId } = await createAgentWithModelProvider(actor);
    const scheduleName = uniqueScheduleName("bdd-schedule");

    const unauthorizedList = await api.requestListSchedules(null, [401]);
    expectApiError(unauthorizedList.body);
    expect(unauthorizedList.body.error.code).toBe("UNAUTHORIZED");

    const invalidBody = await api.requestDeployScheduleUnchecked(
      actor,
      {
        name: scheduleName,
        agentId,
        prompt: "missing a trigger",
        timezone: "UTC",
      },
      [400],
    );
    expectApiError(invalidBody.body);
    expect(invalidBody.body.error.code).toBe("BAD_REQUEST");

    const deployed = await api.deploySchedule(actor, {
      name: scheduleName,
      agentId,
      intervalSeconds: 60,
      prompt: "Run the scheduled status report.",
      description: "Scheduled BDD report",
      timezone: "UTC",
      enabled: false,
    });
    expect(deployed.created).toBeTruthy();
    expect(deployed.schedule).toMatchObject({
      name: scheduleName,
      agentId,
      enabled: false,
      triggerType: "loop",
      intervalSeconds: 60,
    });

    const listedAfterCreate = await api.listSchedules(actor);
    expect(
      findSchedule(listedAfterCreate.schedules, deployed.schedule.id),
    ).toBeDefined();

    const enabled = await api.enableSchedule(actor, deployed.schedule);
    expect(enabled.enabled).toBeTruthy();
    expect(enabled.nextRunAt).not.toBeNull();

    const outsiderEnable = await api.requestEnableSchedule(
      outsider,
      deployed.schedule,
      [404],
    );
    expectApiError(outsiderEnable.body);
    expect(outsiderEnable.body.error.code).toBe("NOT_FOUND");

    const runNow = await api.runScheduleNow(actor, deployed.schedule.id, [402]);
    expectApiError(runNow.body);
    expect(runNow.body.error.code).toBe("INSUFFICIENT_CREDITS");

    const disabled = await api.disableSchedule(actor, deployed.schedule);
    expect(disabled.enabled).toBeFalsy();

    await api.deleteSchedule(actor, deployed.schedule);
    const listedAfterDelete = await api.listSchedules(actor);
    expect(
      findSchedule(listedAfterDelete.schedules, deployed.schedule.id),
    ).toBeUndefined();

    const deleteAgain = await api.requestDeleteSchedule(
      actor,
      deployed.schedule,
      [404],
    );
    expectApiError(deleteAgain.body);
    expect(deleteAgain.body.error.code).toBe("NOT_FOUND");
  });

  it("manually runs a schedule through chat, claim, model, and grant surfaces", async () => {
    const api = createRunsSchedulesApi(context);
    const chat = createChatFilesBddApi(context);
    const fw = createFirewallApi(context);
    const { actor, agentId, runnerGroup } = await entitledScheduleActor();

    const provider = await api.createOrgModelProvider(actor, {
      type: "anthropic-api-key",
      secret: "schedule-model-key",
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-4-7",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: provider.providerId,
      },
    ]);

    await fw.seedTestConnector(actor, {
      connectorName: "slack",
      authMethod: "oauth",
      accessToken: "xoxb-schedule-grant",
    });
    await api.enableAgentConnectors(actor, agentId, ["slack"]);
    await api.upsertUserPermissionGrant(actor, {
      agentId,
      connectorRef: "slack",
      permission: "chat:write",
      action: "allow",
    });

    const deployed = await api.deploySchedule(actor, {
      name: uniqueScheduleName("bdd-run-now"),
      agentId,
      cronExpression: "0 9 * * *",
      prompt: "Manual run test",
      description: "Run-now schedule description",
      appendSystemPrompt: "Use the schedule-specific context.",
      timezone: "UTC",
      enabled: false,
    });

    const created = await api.runScheduleNow(
      actor,
      deployed.schedule.id,
      [201],
    );
    if (created.status !== 201) {
      throw new Error("Expected schedule run-now to create a run");
    }
    const runId = created.body.runId;

    const thread = await chat.listThreadMessages(
      actor,
      deployed.schedule.chatThreadId,
    );
    const userMessage = thread.messages.find((message) => {
      return message.role === "user" && message.runId === runId;
    });
    expect(userMessage).toMatchObject({
      content: "Manual run test",
      scheduleTitle: deployed.schedule.name,
      scheduleSnapshot: {
        id: deployed.schedule.id,
        title: deployed.schedule.name,
        description: "Run-now schedule description",
      },
    });
    expect(userMessage?.scheduleId).toBeUndefined();

    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(runId);
    expect(claim.prompt).toBe("Manual run test");
    expect(claim.appendSystemPrompt).toContain(
      "# Current Integration\nYou are currently running inside: Schedule",
    );
    expect(claim.appendSystemPrompt).toContain("Trigger type: manual");
    expect(claim.appendSystemPrompt).toContain(
      "Use the schedule-specific context.",
    );
    expect(claim.environment?.ANTHROPIC_MODEL).toBe("claude-opus-4-7");
    expect(claim.networkPolicies?.slack?.allow).toContain("chat:write");
    expect(claim.networkPolicies?.slack?.deny).not.toContain("chat:write");

    const conflict = await api.runScheduleNow(
      actor,
      deployed.schedule.id,
      [409],
    );
    expectApiError(conflict.body);
    expect(conflict.body.error.code).toBe("CONFLICT");

    await api.requestCancelRun(actor, runId, [200]);
    await api.deleteSchedule(actor, deployed.schedule);
  });

  it("redeploys a cron schedule and exposes updated state through schedule list", async () => {
    const bdd = createBddApi(context);
    const api = createRunsSchedulesApi(context);
    const actor = bdd.user();
    const { agentId } = await createAgentWithModelProvider(actor);
    const scheduleName = uniqueScheduleName("bdd-cron-update");

    const deployed = await api.deploySchedule(actor, {
      name: scheduleName,
      agentId,
      cronExpression: "0 9 * * *",
      prompt: "Run the morning report.",
      description: "Morning cron report",
      timezone: "UTC",
      enabled: false,
    });
    expect(deployed.created).toBeTruthy();
    expect(deployed.schedule).toMatchObject({
      name: scheduleName,
      agentId,
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      prompt: "Run the morning report.",
      description: "Morning cron report",
      enabled: false,
    });

    const updated = await api.deploySchedule(actor, {
      name: scheduleName,
      agentId,
      cronExpression: "30 9 * * *",
      prompt: "Run the updated morning report.",
      description: "Updated morning cron report",
      timezone: "America/New_York",
      enabled: false,
    });
    expect(updated.created).toBeFalsy();
    expect(updated.schedule.id).toBe(deployed.schedule.id);
    expect(updated.schedule.chatThreadId).toBe(deployed.schedule.chatThreadId);
    expect(updated.schedule).toMatchObject({
      name: scheduleName,
      agentId,
      triggerType: "cron",
      cronExpression: "30 9 * * *",
      timezone: "America/New_York",
      prompt: "Run the updated morning report.",
      description: "Updated morning cron report",
      enabled: false,
    });

    const listed = await api.listSchedules(actor);
    const listedSchedule = findSchedule(listed.schedules, deployed.schedule.id);
    if (!listedSchedule) {
      throw new Error("Expected redeployed schedule to be visible in list");
    }
    expect(listedSchedule).toMatchObject({
      id: deployed.schedule.id,
      name: scheduleName,
      agentId,
      triggerType: "cron",
      cronExpression: "30 9 * * *",
      timezone: "America/New_York",
      prompt: "Run the updated morning report.",
      description: "Updated morning cron report",
      enabled: false,
      chatThreadId: deployed.schedule.chatThreadId,
    });

    await api.deleteSchedule(actor, updated.schedule);
  });

  it("links schedules to chat threads and keeps mutation boundaries visible", async () => {
    const bdd = createBddApi(context);
    const api = createRunsSchedulesApi(context);
    const chat = createChatFilesBddApi(context);
    const actor = bdd.user();
    const outsider = bdd.user();
    const { agentId } = await createAgentWithModelProvider(actor);
    context.mocks.ably.publish.mockResolvedValue(undefined);

    const linkedThread = await chat.createThread(actor, {
      agentId,
      title: "Linked schedule thread",
    });
    const otherThread = await chat.createThread(actor, {
      agentId,
      title: "Ignored schedule thread",
    });
    const outsiderAgent = await bdd.createAgent(outsider, {
      displayName: "Outsider schedule agent",
      description: "Owns an unrelated chat thread.",
      visibility: "private",
    });
    const outsiderThread = await chat.createThread(outsider, {
      agentId: outsiderAgent.agentId,
      title: "Outsider thread",
    });

    const crossUserThread = await api.requestDeployScheduleUnchecked(
      actor,
      {
        name: uniqueScheduleName("bdd-cross-thread"),
        agentId,
        cronExpression: "0 9 * * *",
        prompt: "Should not link a foreign thread.",
        description: "Cross-user thread rejection",
        timezone: "UTC",
        chatThreadId: outsiderThread.id,
      },
      [400],
    );
    expectApiError(crossUserThread.body);
    expect(crossUserThread.body.error.code).toBe("BAD_REQUEST");

    context.mocks.ably.publish.mockClear();
    const linked = await api.deploySchedule(actor, {
      name: uniqueScheduleName("bdd-linked-thread"),
      agentId,
      cronExpression: "0 9 * * *",
      prompt: "Run the linked thread report.",
      description: "Linked thread schedule",
      timezone: "UTC",
      enabled: false,
      chatThreadId: linkedThread.id,
    });
    expect(linked.schedule.chatThreadId).toBe(linkedThread.id);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadSchedulesChanged:${linkedThread.id}`,
      null,
    );

    const redeployed = await api.deploySchedule(actor, {
      name: linked.schedule.name,
      agentId,
      cronExpression: "0 10 * * *",
      prompt: "Run the updated linked thread report.",
      description: "Updated linked thread schedule",
      timezone: "UTC",
      enabled: false,
      chatThreadId: otherThread.id,
    });
    expect(redeployed.created).toBeFalsy();
    expect(redeployed.schedule.chatThreadId).toBe(linkedThread.id);

    const autoThreadSchedule = await api.deploySchedule(actor, {
      name: uniqueScheduleName("bdd-auto-thread"),
      agentId,
      cronExpression: "0 11 * * *",
      prompt: "Run the auto-thread report.",
      description: "Auto-created schedule thread",
      timezone: "UTC",
      enabled: false,
    });
    const autoThread = await chat.readThread(
      actor,
      autoThreadSchedule.schedule.chatThreadId,
    );
    expect(autoThread.title).toBe("Auto-created schedule thread");

    const pastOnce = await api.requestDeployScheduleUnchecked(
      actor,
      {
        name: uniqueScheduleName("bdd-past-once"),
        agentId,
        atTime: new Date(now() - 86_400_000).toISOString(),
        prompt: "Past one-time schedule",
        description: "Past one-time schedule",
        timezone: "UTC",
        enabled: false,
      },
      [400],
    );
    expectApiError(pastOnce.body);
    expect(pastOnce.body.error.code).toBe("BAD_REQUEST");

    const readOnlyToken = zeroToken(actor, ["automation:read"]);
    const forbiddenDelete = await api.requestDeleteScheduleAs(
      `Bearer ${readOnlyToken}`,
      autoThreadSchedule.schedule,
      [403],
    );
    expectApiError(forbiddenDelete.body);
    expect(forbiddenDelete.body.error.code).toBe("FORBIDDEN");

    const missingDelete = await api.requestDeleteSchedule(
      actor,
      { name: uniqueScheduleName("bdd-missing-delete") },
      [404],
    );
    expectApiError(missingDelete.body);
    expect(missingDelete.body.error.code).toBe("NOT_FOUND");

    context.mocks.ably.publish.mockClear();
    await api.deleteSchedule(actor, linked.schedule);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadSchedulesChanged:${linkedThread.id}`,
      null,
    );
    await api.deleteSchedule(actor, autoThreadSchedule.schedule);
  });

  it("lets cron execution process a due loop schedule and exposes the transition through list", async () => {
    const bdd = createBddApi(context);
    const api = createRunsSchedulesApi(context);
    const actor = bdd.user();
    const { agentId } = await createAgentWithModelProvider(actor);
    const scheduleName = uniqueScheduleName("bdd-cron");

    const deployed = await api.deploySchedule(actor, {
      name: scheduleName,
      agentId,
      intervalSeconds: 1,
      prompt: "Run from cron.",
      description: "Cron due schedule",
      timezone: "UTC",
      enabled: true,
    });
    expect(deployed.schedule.nextRunAt).not.toBeNull();

    const cron = await api.executeSchedulesCron(true);
    if (cron.status !== 200) {
      throw new Error("Expected execute schedules cron to succeed");
    }
    expect(cron.body.success).toBeTruthy();
    expect(cron.body.executed).toBe(0);
    expect(cron.body.skipped).toBeGreaterThanOrEqual(1);

    const afterCron = await api.listSchedules(actor);
    const schedule = afterCron.schedules.find((item) => {
      return item.id === deployed.schedule.id;
    });
    expect(schedule?.lastRunAt).not.toBeNull();
    expect(schedule?.consecutiveFailures).toBeGreaterThanOrEqual(1);
  });
});

describe("SCHED-02 and CHAIN-SCHEDULE: cron execution of due schedules", () => {
  it("executes due cron and one-time schedules and exposes the runs through queue, chat, and runner reads", async () => {
    const api = createRunsSchedulesApi(context);
    const chat = createChatFilesBddApi(context);
    const { actor, agentId, runnerGroup } = await entitledScheduleActor();
    const cronPrompt = "Run the scheduled morning report.";
    const oncePrompt = "Run the one-time report.";
    // Mocked time only moves minutes ahead of real time: runs persist real
    // creation timestamps, and active-run accounting ignores pending runs
    // older than its TTL relative to the mockable clock.
    const base = now();
    mockNow(base);

    const cronSchedule = await api.deploySchedule(actor, {
      name: uniqueScheduleName("bdd-exec-cron"),
      agentId,
      cronExpression: "*/5 * * * *",
      prompt: cronPrompt,
      description: "Due cron schedule",
      appendSystemPrompt: "Always respond in formal tone",
      timezone: "UTC",
      enabled: true,
    });
    expect(cronSchedule.schedule.nextRunAt).not.toBeNull();

    const onceSchedule = await api.deploySchedule(actor, {
      name: uniqueScheduleName("bdd-exec-once"),
      agentId,
      atTime: new Date(base + 5 * 60_000).toISOString(),
      prompt: oncePrompt,
      description: "Due one-time schedule",
      timezone: "UTC",
      enabled: true,
    });
    expect(onceSchedule.schedule.nextRunAt).not.toBeNull();

    await executeSchedulesCronOk();
    const preDue = await api.listSchedules(actor);
    expect(
      mustFindSchedule(preDue.schedules, cronSchedule.schedule.id).lastRunAt,
    ).toBeNull();
    expect(
      mustFindSchedule(preDue.schedules, onceSchedule.schedule.id).lastRunAt,
    ).toBeNull();

    mockNow(base + 6 * 60_000);
    const [firstCron, secondCron] = await Promise.all([
      api.executeSchedulesCron(true),
      api.executeSchedulesCron(true),
    ]);
    expect(firstCron.status).toBe(200);
    expect(secondCron.status).toBe(200);

    const queue = await api.readRunQueue(actor);
    expect(queue.body.concurrency.active).toBe(2);
    expect(queue.body.queue).toHaveLength(0);

    const afterDue = await api.listSchedules(actor);
    const cronAfterDue = mustFindSchedule(
      afterDue.schedules,
      cronSchedule.schedule.id,
    );
    expect(cronAfterDue).toMatchObject({
      enabled: true,
      nextRunAt: null,
      retryStartedAt: null,
      consecutiveFailures: 0,
    });
    expect(cronAfterDue.lastRunAt).not.toBeNull();
    const onceAfterDue = mustFindSchedule(
      afterDue.schedules,
      onceSchedule.schedule.id,
    );
    expect(onceAfterDue).toMatchObject({ enabled: false, nextRunAt: null });
    expect(onceAfterDue.lastRunAt).not.toBeNull();

    const cronThread = await chat.listThreadMessages(
      actor,
      cronSchedule.schedule.chatThreadId,
    );
    const cronRunId = scheduleRunIdFromThread(cronThread.messages, cronPrompt);
    expect(hasQueueMarker(cronThread.messages, cronRunId)).toBeFalsy();
    const onceThread = await chat.listThreadMessages(
      actor,
      onceSchedule.schedule.chatThreadId,
    );
    const onceRunId = scheduleRunIdFromThread(onceThread.messages, oncePrompt);
    expect(onceRunId).not.toBe(cronRunId);

    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(cronRunId);
    expect(claim.prompt).toBe(cronPrompt);
    expect(claim.appendSystemPrompt).toContain(
      "# Current Integration\nYou are currently running inside: Schedule",
    );
    expect(claim.appendSystemPrompt).toContain("Trigger type: cron");
    expect(claim.appendSystemPrompt).toContain("Always respond in formal tone");

    const conflict = await api.runScheduleNow(
      actor,
      cronSchedule.schedule.id,
      [409],
    );
    expectApiError(conflict.body);
    expect(conflict.body.error.code).toBe("CONFLICT");

    clearMockNow();
    await api.requestCancelRun(actor, cronRunId, [200]);
    await api.requestCancelRun(actor, onceRunId, [200]);
    const emptied = await api.readRunQueue(actor);
    expect(emptied.body.concurrency.active).toBe(0);
    await api.deleteSchedule(actor, cronSchedule.schedule);
    await api.deleteSchedule(actor, onceSchedule.schedule);
  });

  it("skips a due schedule while its previous run is active and executes it after the run terminates", async () => {
    const api = createRunsSchedulesApi(context);
    const chat = createChatFilesBddApi(context);
    const { actor, agentId } = await entitledScheduleActor();
    const prompt = "Run the skip-check report.";
    const base = now();
    mockNow(base);

    const deployed = await api.deploySchedule(actor, {
      name: uniqueScheduleName("bdd-skip-active"),
      agentId,
      cronExpression: "0 9 * * *",
      prompt,
      description: "Skip while previous run is active",
      timezone: "UTC",
      enabled: true,
    });
    const deployedNextRunAt = deployed.schedule.nextRunAt;
    expect(deployedNextRunAt).not.toBeNull();

    const manualRun = await api.runScheduleNow(
      actor,
      deployed.schedule.id,
      [201],
    );
    if (manualRun.status !== 201) {
      throw new Error("Expected manual schedule run to be created");
    }
    const manualRunId = manualRun.body.runId;

    const afterManual = await chat.listThreadMessages(
      actor,
      deployed.schedule.chatThreadId,
    );
    expect(scheduleUserMessages(afterManual.messages, prompt)).toHaveLength(1);

    mockNow(base + 25 * 3_600_000);
    await executeSchedulesCronOk();

    const skipped = mustFindSchedule(
      (await api.listSchedules(actor)).schedules,
      deployed.schedule.id,
    );
    expect(skipped.lastRunAt).toBeNull();
    expect(skipped.nextRunAt).toBe(deployedNextRunAt);
    expect(skipped.consecutiveFailures).toBe(0);

    await api.requestCancelRun(actor, manualRunId, [200]);
    await executeSchedulesCronOk();

    const executed = mustFindSchedule(
      (await api.listSchedules(actor)).schedules,
      deployed.schedule.id,
    );
    expect(executed.lastRunAt).not.toBeNull();
    expect(executed.nextRunAt).toBeNull();

    const afterCron = await chat.listThreadMessages(
      actor,
      deployed.schedule.chatThreadId,
    );
    const cronMessages = scheduleUserMessages(afterCron.messages, prompt);
    expect(cronMessages).toHaveLength(2);
    const cronRunId = cronMessages
      .map((message) => {
        return message.runId;
      })
      .find((runId): runId is string => {
        return runId !== undefined && runId !== manualRunId;
      });
    if (!cronRunId) {
      throw new Error("Expected the cron execution to post a second run");
    }

    clearMockNow();
    await api.requestCancelRun(actor, cronRunId, [200]);
    await api.deleteSchedule(actor, deployed.schedule);
  });

  it("queues scheduled runs at the org concurrency limit and disables a queued one-time schedule", async () => {
    const api = createRunsSchedulesApi(context);
    const chat = createChatFilesBddApi(context);
    const { actor, agentId } = await entitledScheduleActor();
    const cronPrompt = "Run the queued cron report.";
    const oncePrompt = "Run the queued one-time report.";

    const blockerOne = await api.createRun(actor, {
      agentId,
      prompt: "hold concurrency slot one",
      modelProvider: "anthropic-api-key",
    });
    const blockerTwo = await api.createRun(actor, {
      agentId,
      prompt: "hold concurrency slot two",
      modelProvider: "anthropic-api-key",
    });

    // The mocked due time stays within the pending-run accounting TTL so the
    // real-time blocking runs still count against the concurrency limit.
    const base = now();
    mockNow(base);
    const cronSchedule = await api.deploySchedule(actor, {
      name: uniqueScheduleName("bdd-queue-cron"),
      agentId,
      cronExpression: "*/5 * * * *",
      prompt: cronPrompt,
      description: "Queued cron schedule",
      timezone: "UTC",
      enabled: true,
    });
    const onceSchedule = await api.deploySchedule(actor, {
      name: uniqueScheduleName("bdd-queue-once"),
      agentId,
      atTime: new Date(base + 5 * 60_000).toISOString(),
      prompt: oncePrompt,
      description: "Queued one-time schedule",
      timezone: "UTC",
      enabled: true,
    });

    mockNow(base + 6 * 60_000);
    await executeSchedulesCronOk();

    const queue = await api.readRunQueue(actor);
    expect(queue.body.queue).toHaveLength(2);
    const queuedRunIds = queue.body.queue.map((entry) => {
      return entry.runId;
    });

    const schedules = await api.listSchedules(actor);
    expect(
      mustFindSchedule(schedules.schedules, cronSchedule.schedule.id),
    ).toMatchObject({ enabled: true, retryStartedAt: null, nextRunAt: null });
    expect(
      mustFindSchedule(schedules.schedules, onceSchedule.schedule.id),
    ).toMatchObject({ enabled: false, nextRunAt: null });

    const cronThread = await chat.listThreadMessages(
      actor,
      cronSchedule.schedule.chatThreadId,
    );
    const cronRunId = scheduleRunIdFromThread(cronThread.messages, cronPrompt);
    expect(hasQueueMarker(cronThread.messages, cronRunId)).toBeTruthy();
    const onceThread = await chat.listThreadMessages(
      actor,
      onceSchedule.schedule.chatThreadId,
    );
    const onceRunId = scheduleRunIdFromThread(onceThread.messages, oncePrompt);
    expect(hasQueueMarker(onceThread.messages, onceRunId)).toBeTruthy();
    expect([...queuedRunIds].sort()).toStrictEqual(
      [cronRunId, onceRunId].sort(),
    );

    clearMockNow();
    await api.requestCancelRun(actor, cronRunId, [200]);
    await api.requestCancelRun(actor, onceRunId, [200]);
    await api.requestCancelRun(actor, blockerOne.runId, [200]);
    await api.requestCancelRun(actor, blockerTwo.runId, [200]);
    const emptied = await api.readRunQueue(actor);
    expect(emptied.body.concurrency.active).toBe(0);
    await api.deleteSchedule(actor, cronSchedule.schedule);
    await api.deleteSchedule(actor, onceSchedule.schedule);
  });

  it("advances loop and cron schedules after pre-run failures and auto-disables after three consecutive failures", async () => {
    const bdd = createBddApi(context);
    const api = createRunsSchedulesApi(context);
    const actor = bdd.user();
    const { agentId } = await createAgentWithModelProvider(actor);
    const base = now();
    mockNow(base);

    const loopSchedule = await api.deploySchedule(actor, {
      name: uniqueScheduleName("bdd-fail-loop"),
      agentId,
      intervalSeconds: 300,
      prompt: "Run the failing loop report.",
      description: "Loop pre-run failure schedule",
      timezone: "UTC",
      enabled: true,
    });
    expect(loopSchedule.schedule.nextRunAt).not.toBeNull();

    await executeSchedulesCronOk();
    const afterFirst = mustFindSchedule(
      (await api.listSchedules(actor)).schedules,
      loopSchedule.schedule.id,
    );
    expect(afterFirst.consecutiveFailures).toBe(1);
    expect(afterFirst.enabled).toBeTruthy();
    expect(afterFirst.lastRunAt).not.toBeNull();
    if (!afterFirst.nextRunAt) {
      throw new Error("Expected the loop failure to reschedule the next run");
    }
    expect(Date.parse(afterFirst.nextRunAt)).toBeGreaterThan(base);

    mockNow(base + 301_000);
    await executeSchedulesCronOk();
    const afterSecond = mustFindSchedule(
      (await api.listSchedules(actor)).schedules,
      loopSchedule.schedule.id,
    );
    expect(afterSecond.consecutiveFailures).toBe(2);
    expect(afterSecond.enabled).toBeTruthy();

    mockNow(base + 602_000);
    await executeSchedulesCronOk();
    const afterThird = mustFindSchedule(
      (await api.listSchedules(actor)).schedules,
      loopSchedule.schedule.id,
    );
    expect(afterThird).toMatchObject({
      consecutiveFailures: 3,
      enabled: false,
      nextRunAt: null,
    });

    const cronSchedule = await api.deploySchedule(actor, {
      name: uniqueScheduleName("bdd-fail-cron"),
      agentId,
      cronExpression: "0 9 * * *",
      prompt: "Run the failing cron report.",
      description: "Cron pre-run failure schedule",
      timezone: "UTC",
      enabled: true,
    });
    mockNow(base + 25 * 3_600_000);
    await executeSchedulesCronOk();
    const cronAfterFailure = mustFindSchedule(
      (await api.listSchedules(actor)).schedules,
      cronSchedule.schedule.id,
    );
    expect(cronAfterFailure.consecutiveFailures).toBe(1);
    expect(cronAfterFailure.enabled).toBeTruthy();
    if (!cronAfterFailure.nextRunAt) {
      throw new Error("Expected the cron failure to reschedule the next run");
    }
    expect(Date.parse(cronAfterFailure.nextRunAt)).toBeGreaterThan(
      base + 25 * 3_600_000,
    );

    const pinActor = bdd.user();
    const pinAgent = await bdd.createAgent(pinActor, {
      displayName: "BDD pin-error agent",
      description: "Covers the schedule model-pin failure branch.",
      visibility: "private",
    });
    const pinSchedule = await api.deploySchedule(pinActor, {
      name: uniqueScheduleName("bdd-fail-pin"),
      agentId: pinAgent.agentId,
      intervalSeconds: 300,
      prompt: "Run the pin-error report.",
      description: "Model pin failure schedule",
      timezone: "UTC",
      enabled: true,
    });
    await executeSchedulesCronOk();
    const pinAfterFailure = mustFindSchedule(
      (await api.listSchedules(pinActor)).schedules,
      pinSchedule.schedule.id,
    );
    expect(pinAfterFailure.consecutiveFailures).toBe(1);
    expect(pinAfterFailure.enabled).toBeTruthy();
    expect(pinAfterFailure.nextRunAt).not.toBeNull();

    clearMockNow();
    await api.deleteSchedule(actor, loopSchedule.schedule);
    await api.deleteSchedule(actor, cronSchedule.schedule);
    await api.deleteSchedule(pinActor, pinSchedule.schedule);
  });
});

const LOOP_CALLBACK_PATH = "/api/internal/callbacks/trigger/loop";
const CRON_CALLBACK_PATH = "/api/internal/callbacks/trigger/cron";
const CHAT_CALLBACK_PATH = "/api/internal/callbacks/chat";

/**
 * Quiet capture handlers for every callback URL a schedule-fired run can
 * carry (trigger reschedule + chat), so terminal dispatch never hits an
 * unhandled MSW route. Returns the captures the chains assert on.
 */
function captureScheduleCallbackDeliveries(
  webhooks: ReturnType<typeof createWebhookCallbackApi>,
) {
  const loop = webhooks.captureInternalCallbackDeliveries(LOOP_CALLBACK_PATH);
  const cron = webhooks.captureInternalCallbackDeliveries(CRON_CALLBACK_PATH);
  const chat = webhooks.captureInternalCallbackDeliveries(CHAT_CALLBACK_PATH);
  return { loop, cron, chat };
}

async function waitForCallbackDeliveryWithStatus(
  deliveries: readonly ReturnType<typeof callbackDeliveryWithStatus>[],
  status: "completed" | "failed" | "progress",
): Promise<ReturnType<typeof callbackDeliveryWithStatus>> {
  let delivery: ReturnType<typeof callbackDeliveryWithStatus> | undefined;
  await expect
    .poll(async () => {
      const result = await settle(
        Promise.resolve().then(() => {
          return callbackDeliveryWithStatus(deliveries, status);
        }),
      );
      delivery = result.ok ? result.value : undefined;
      return delivery !== undefined;
    })
    .toBe(true);
  if (!delivery) {
    throw new Error(`Expected a captured ${status} callback delivery`);
  }
  return delivery;
}

async function completeScheduleRun(
  sandboxToken: string,
  runId: string,
): Promise<void> {
  const webhooks = createWebhookCallbackApi(context);
  const sandboxHeaders = { authorization: `Bearer ${sandboxToken}` };
  await webhooks.requestAgentCheckpoint(
    {
      runId,
      cliAgentType: "claude-code",
      cliAgentSessionId: `bdd-schedule-cli-${runId}`,
      cliAgentSessionHistoryHash: createHash("sha256")
        .update(`bdd schedule history ${runId}`)
        .digest("hex"),
    },
    sandboxHeaders,
    [200],
  );
  await webhooks.requestAgentComplete(
    { runId, exitCode: 0 },
    sandboxHeaders,
    [200],
  );
}

describe("HOOK-01: schedule reschedule callbacks through replayed deliveries", () => {
  it("advances and skips loop schedules through replayed reschedule callbacks", async () => {
    const api = createRunsSchedulesApi(context);
    const chat = createChatFilesBddApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const { actor, agentId, runnerGroup } = await entitledScheduleActor();
    const prompt = "Run the loop callback report.";
    // Pin the clock so every replay stays inside the 5-minute signature
    // tolerance window of its captured X-VM0-Timestamp.
    const base = now();
    mockNow(base);
    const deliveries = captureScheduleCallbackDeliveries(webhooks);

    const deployed = await api.deploySchedule(actor, {
      name: uniqueScheduleName("bdd-loop-cb"),
      agentId,
      intervalSeconds: 600,
      prompt,
      description: "Loop reschedule callback schedule",
      timezone: "UTC",
      enabled: true,
    });

    // Fire the due schedule (the jump stays inside PENDING_RUN_TTL).
    mockNow(base + 601_000);
    await executeSchedulesCronOk();
    const thread = await chat.listThreadMessages(
      actor,
      deployed.schedule.chatThreadId,
    );
    const runId = scheduleRunIdFromThread(thread.messages, prompt);

    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(runId);

    // A sandbox heartbeat dispatches a progress delivery to the loop path;
    // replaying it skips without touching the schedule.
    await webhooks.requestAgentHeartbeat(
      { runId },
      { authorization: `Bearer ${claim.sandboxToken}` },
      [200],
    );
    const progressDelivery = await waitForCallbackDeliveryWithStatus(
      deliveries.loop,
      "progress",
    );
    const progressReplay = await webhooks.replayInternalCallback(
      LOOP_CALLBACK_PATH,
      progressDelivery,
    );
    expect(progressReplay.status).toBe(200);
    await expect(progressReplay.json()).resolves.toStrictEqual({
      success: true,
      skipped: true,
    });
    expect(
      mustFindSchedule(
        (await api.listSchedules(actor)).schedules,
        deployed.schedule.id,
      ).consecutiveFailures,
    ).toBe(0);

    await completeScheduleRun(claim.sandboxToken, runId);
    const completedDelivery = await waitForCallbackDeliveryWithStatus(
      deliveries.loop,
      "completed",
    );
    const chatCompletedDelivery = await waitForCallbackDeliveryWithStatus(
      deliveries.chat,
      "completed",
    );

    const tamperedReplay = await webhooks.replayInternalCallback(
      LOOP_CALLBACK_PATH,
      completedDelivery,
      { signature: webhooks.tamperedSignature(completedDelivery) },
    );
    expect(tamperedReplay.status).toBe(401);

    // A signature of the wrong length fails before the timing-safe compare.
    const malformedSignatureReplay = await webhooks.replayInternalCallback(
      LOOP_CALLBACK_PATH,
      completedDelivery,
      { signature: "invalid-signature" },
    );
    expect(malformedSignatureReplay.status).toBe(401);

    // Cross-path replays verify their signatures (callback rows resolve by
    // callbackId, not path) and then fail the path-specific payload parse.
    const chatOnLoop = await webhooks.replayInternalCallback(
      LOOP_CALLBACK_PATH,
      chatCompletedDelivery,
    );
    expect(chatOnLoop.status).toBe(400);
    await expect(chatOnLoop.json()).resolves.toStrictEqual({
      error: "Invalid or missing payload",
    });
    const loopOnCron = await webhooks.replayInternalCallback(
      CRON_CALLBACK_PATH,
      completedDelivery,
    );
    expect(loopOnCron.status).toBe(400);
    await expect(loopOnCron.json()).resolves.toStrictEqual({
      error: "Invalid or missing payload",
    });

    // The completion advance reads the interval from the database at replay
    // time: redeploy with a new interval, move the pinned clock (still inside
    // the signature tolerance), and replay the same captured delivery.
    const redeployed = await api.deploySchedule(actor, {
      name: deployed.schedule.name,
      agentId,
      intervalSeconds: 1200,
      prompt,
      description: "Loop reschedule callback schedule",
      timezone: "UTC",
      enabled: true,
    });
    mockNow(base + 721_000);
    const queryCallsBefore = context.mocks.axiom.query.mock.calls.length;
    const advancedReplay = await webhooks.replayInternalCallback(
      LOOP_CALLBACK_PATH,
      completedDelivery,
    );
    expect(advancedReplay.status).toBe(200);
    await expect(advancedReplay.json()).resolves.toStrictEqual({
      success: true,
      skipped: true,
    });
    // The reschedule callback never reads run output or writes a summary;
    // the chat callback owns the summary (D9).
    expect(context.mocks.axiom.query.mock.calls).toHaveLength(queryCallsBefore);
    const advancedSchedule = mustFindSchedule(
      (await api.listSchedules(actor)).schedules,
      deployed.schedule.id,
    );
    expect(advancedSchedule).toMatchObject({
      consecutiveFailures: 0,
      enabled: true,
      nextRunAt: redeployed.schedule.nextRunAt,
    });

    // Signed-shape posts for unknown runs fail the callback lookup before
    // signature verification.
    const missingCallback = await webhooks.replayInternalCallback(
      LOOP_CALLBACK_PATH,
      {
        body: JSON.stringify({
          runId: randomUUID(),
          status: "completed",
          payload: { scheduleId: deployed.schedule.id },
        }),
        headers: {
          "content-type": "application/json",
          "x-vm0-signature": "0".repeat(64),
          "x-vm0-timestamp": String(Math.floor(now() / 1000)),
        },
      },
    );
    expect(missingCallback.status).toBe(404);

    // Disabled and deleted schedules skip the completion advance.
    await api.disableSchedule(actor, deployed.schedule);
    const disabledReplay = await webhooks.replayInternalCallback(
      LOOP_CALLBACK_PATH,
      completedDelivery,
    );
    expect(disabledReplay.status).toBe(200);
    await expect(disabledReplay.json()).resolves.toStrictEqual({
      success: true,
      skipped: true,
    });
    await api.deleteSchedule(actor, deployed.schedule);
    const deletedReplay = await webhooks.replayInternalCallback(
      LOOP_CALLBACK_PATH,
      completedDelivery,
    );
    expect(deletedReplay.status).toBe(200);
    await expect(deletedReplay.json()).resolves.toStrictEqual({
      success: true,
      skipped: true,
    });
    clearMockNow();
  });

  it("increments cron failures and auto-disables after three replayed failed callbacks", async () => {
    const api = createRunsSchedulesApi(context);
    const chat = createChatFilesBddApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const { actor, agentId } = await entitledScheduleActor();
    const prompt = "Run the cron failure report.";
    const base = now();
    mockNow(base);
    const deliveries = captureScheduleCallbackDeliveries(webhooks);

    const deployed = await api.deploySchedule(actor, {
      name: uniqueScheduleName("bdd-cron-cb"),
      agentId,
      cronExpression: "*/5 * * * *",
      prompt,
      description: "Cron failure callback schedule",
      timezone: "UTC",
      enabled: true,
    });

    mockNow(base + 6 * 60_000);
    await executeSchedulesCronOk();
    const thread = await chat.listThreadMessages(
      actor,
      deployed.schedule.chatThreadId,
    );
    const runId = scheduleRunIdFromThread(thread.messages, prompt);

    // Cancelling the dispatched run delivers a failed callback
    // (error "Run cancelled") that the chain replays three times — the
    // handler re-reads consecutiveFailures from the database on each replay.
    await api.requestCancelRun(actor, runId, [200]);
    const failedDelivery = await waitForCallbackDeliveryWithStatus(
      deliveries.cron,
      "failed",
    );

    // "*/5 * * * *" advances to the next 5-minute boundary after the pinned
    // clock, computed here instead of importing the cron service.
    const expectedNextRunAt = new Date(
      (Math.floor((base + 6 * 60_000) / 300_000) + 1) * 300_000,
    ).toISOString();

    const firstReplay = await webhooks.replayInternalCallback(
      CRON_CALLBACK_PATH,
      failedDelivery,
    );
    expect(firstReplay.status).toBe(200);
    await expect(firstReplay.json()).resolves.toStrictEqual({ success: true });
    expect(
      mustFindSchedule(
        (await api.listSchedules(actor)).schedules,
        deployed.schedule.id,
      ),
    ).toMatchObject({
      consecutiveFailures: 1,
      enabled: true,
      nextRunAt: expectedNextRunAt,
    });

    const secondReplay = await webhooks.replayInternalCallback(
      CRON_CALLBACK_PATH,
      failedDelivery,
    );
    expect(secondReplay.status).toBe(200);
    expect(
      mustFindSchedule(
        (await api.listSchedules(actor)).schedules,
        deployed.schedule.id,
      ),
    ).toMatchObject({ consecutiveFailures: 2, enabled: true });

    const thirdReplay = await webhooks.replayInternalCallback(
      CRON_CALLBACK_PATH,
      failedDelivery,
    );
    expect(thirdReplay.status).toBe(200);
    expect(
      mustFindSchedule(
        (await api.listSchedules(actor)).schedules,
        deployed.schedule.id,
      ),
    ).toMatchObject({
      consecutiveFailures: 3,
      enabled: false,
      nextRunAt: null,
    });

    // The fourth replay hits the disabled arm of the cron handler.
    const fourthReplay = await webhooks.replayInternalCallback(
      CRON_CALLBACK_PATH,
      failedDelivery,
    );
    expect(fourthReplay.status).toBe(200);
    await expect(fourthReplay.json()).resolves.toStrictEqual({
      success: true,
      skipped: true,
    });

    await api.deleteSchedule(actor, deployed.schedule);
    clearMockNow();
  });
});

describe("AUTOMATIONS-01: automation lifecycle through the public API", () => {
  it("creates, lists, updates, toggles, runs, and deletes an automation through API requests", async () => {
    const bdd = createBddApi(context);
    const api = createRunsSchedulesApi(context);
    const actor = bdd.user();
    const outsider = bdd.user();
    const { agentId } = await createAgentWithModelProvider(actor);
    const automationName = uniqueScheduleName("bdd-automation");

    await api.enableAutomations(actor);
    await api.enableAutomations(outsider);

    const unauthorizedList = await api.requestListAutomations(null, [401]);
    expectApiError(unauthorizedList.body);
    expect(unauthorizedList.body.error.code).toBe("UNAUTHORIZED");

    const invalidBody = await api.requestCreateAutomationUnchecked(
      actor,
      {
        name: automationName,
        agentId,
        prompt: "missing a trigger",
        timezone: "UTC",
      },
      [400],
    );
    expectApiError(invalidBody.body);
    expect(invalidBody.body.error.code).toBe("BAD_REQUEST");

    const created = await api.createAutomation(actor, {
      name: automationName,
      agentId,
      intervalSeconds: 60,
      prompt: "Run the automation status report.",
      description: "Automation BDD report",
      timezone: "UTC",
      enabled: false,
    });
    expect(created.created).toBeTruthy();
    expect(created.automation).toMatchObject({
      name: automationName,
      agentId,
      enabled: false,
      triggerType: "loop",
      intervalSeconds: 60,
      prompt: "Run the automation status report.",
      description: "Automation BDD report",
    });

    const listedAfterCreate = await api.listAutomations(actor);
    expect(
      findSchedule(listedAfterCreate.automations, created.automation.id),
    ).toMatchObject({
      id: created.automation.id,
      name: automationName,
      triggerType: "loop",
      enabled: false,
    });

    const schedulesAfterCreate = await api.listSchedules(actor);
    expect(
      findSchedule(schedulesAfterCreate.schedules, created.automation.id),
    ).toMatchObject({
      id: created.automation.id,
      name: automationName,
      triggerType: "loop",
      enabled: false,
    });

    const updated = await api.updateAutomation(actor, automationName, {
      agentId,
      cronExpression: "0 9 * * *",
      prompt: "Run the updated automation report.",
      description: "Updated automation BDD report",
      timezone: "America/New_York",
      enabled: true,
    });
    expect(updated.created).toBeFalsy();
    expect(updated.automation.id).toBe(created.automation.id);
    expect(updated.automation).toMatchObject({
      name: automationName,
      agentId,
      enabled: false,
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      timezone: "America/New_York",
      prompt: "Run the updated automation report.",
      description: "Updated automation BDD report",
      chatThreadId: created.automation.chatThreadId,
    });
    expect(updated.automation.nextRunAt).toBeNull();

    const listedAfterUpdate = await api.listAutomations(actor);
    expect(
      findSchedule(listedAfterUpdate.automations, updated.automation.id),
    ).toMatchObject({
      id: updated.automation.id,
      name: automationName,
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      enabled: false,
    });

    const schedulesAfterUpdate = await api.listSchedules(actor);
    expect(
      findSchedule(schedulesAfterUpdate.schedules, updated.automation.id),
    ).toMatchObject({
      id: updated.automation.id,
      name: automationName,
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      enabled: false,
      chatThreadId: created.automation.chatThreadId,
    });

    const disabled = await api.disableAutomation(actor, updated.automation);
    expect(disabled.enabled).toBeFalsy();

    const enabled = await api.enableAutomation(actor, updated.automation);
    expect(enabled.enabled).toBeTruthy();
    expect(enabled.nextRunAt).not.toBeNull();

    const outsiderRun = await api.requestRunAutomation(
      outsider,
      updated.automation.id,
      [404],
    );
    expectApiError(outsiderRun.body);
    expect(outsiderRun.body.error.code).toBe("NOT_FOUND");

    const deniedRun = await api.requestRunAutomation(
      actor,
      updated.automation.id,
      [402],
    );
    expectApiError(deniedRun.body);
    expect(deniedRun.body.error.code).toBe("INSUFFICIENT_CREDITS");

    await api.deleteAutomation(actor, updated.automation);
    const listedAfterDelete = await api.listAutomations(actor);
    expect(
      findSchedule(listedAfterDelete.automations, updated.automation.id),
    ).toBeUndefined();
    const schedulesAfterDelete = await api.listSchedules(actor);
    expect(
      findSchedule(schedulesAfterDelete.schedules, updated.automation.id),
    ).toBeUndefined();

    const deleteAgain = await api.requestDeleteAutomation(
      actor,
      updated.automation,
      [404],
    );
    expectApiError(deleteAgain.body);
    expect(deleteAgain.body.error.code).toBe("NOT_FOUND");
  });
});

describe("SCHED-02: cron routes", () => {
  it("rejects invalid cron auth and accepts safe no-work cron routes with valid auth", async () => {
    const api = createRunsSchedulesApi(context);

    const invalidExecute = await api.executeSchedulesCron(false);
    if (invalidExecute.status !== 401) {
      throw new Error("Expected missing cron auth to be rejected");
    }
    expectApiError(invalidExecute.body);
    expect(invalidExecute.body.error.code).toBe("UNAUTHORIZED");

    const invalidCronRoutes = await api.runSafeCronRoutes(false);
    expect(
      Object.values(invalidCronRoutes).every((response) => {
        return response.status === 401;
      }),
    ).toBeTruthy();

    context.mocks.axiom.query.mockResolvedValue([]);
    const validCronRoutes = await api.runSafeCronRoutes(true);
    expect(
      Object.values(validCronRoutes).every((response) => {
        return response.status === 200;
      }),
    ).toBeTruthy();

    const execute = await api.executeSchedulesCron(true);
    if (execute.status !== 200) {
      throw new Error("Expected execute schedules cron to succeed");
    }
    expect(execute.body.success).toBeTruthy();
  });
});

describe("SCHED-02 and OPS-01: email outbox drain cron", () => {
  it("rejects unauthorized drain requests", async () => {
    const email = createEmailApi(context);

    const unauthorizedDrain = await email.drainEmailOutboxCron(false);
    expect(unauthorizedDrain.status).toBe(401);
  });

  it("marks suppressed pending outbox rows failed without sending", async () => {
    const subject = `BDD drain ${randomUUID().slice(0, 8)}`;
    const to = `bdd-suppressed-${randomUUID().slice(0, 12)}@example.test`;
    await seedEmailOutbox({ subject, to });
    await seedEmailSuppression(to);

    await expect
      .poll(async () => {
        await touchEmailOutbox(subject);
        await drainEmailOutboxCronOk();
        return await emailOutboxRow(subject);
      })
      .toMatchObject({
        status: "failed",
        attempts: 1,
        lastError: `Recipient address suppressed (${to})`,
      });
    expect(resendSendCallsTo(to)).toBe(0);
  });

  it("cleans up expired pending and failed outbox rows", async () => {
    const pendingSubject = `BDD drain ${randomUUID().slice(0, 8)}`;
    const failedSubject = `BDD drain ${randomUUID().slice(0, 8)}`;
    const expiredAt = new Date(now() - 60 * 60 * 1000);
    await seedEmailOutbox({
      subject: pendingSubject,
      to: `bdd-pending-${randomUUID().slice(0, 12)}@example.test`,
      createdAt: expiredAt,
      nextRetryAt: new Date("2100-01-01T00:00:00.000Z"),
    });
    await seedEmailOutbox({
      subject: failedSubject,
      to: `bdd-failed-${randomUUID().slice(0, 12)}@example.test`,
      status: "failed",
      attempts: 3,
      createdAt: expiredAt,
    });

    await expect
      .poll(async () => {
        await drainEmailOutboxCronOk();
        return [
          await emailOutboxStatus(pendingSubject),
          await emailOutboxStatus(failedSubject),
        ];
      })
      .toStrictEqual([null, null]);
  });
});
