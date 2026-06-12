import { createHash, randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import { PRESENTATION_TEMPLATE_ITEMS, VIDEO_STYLE_PRESETS } from "@vm0/core";
import {
  chatMessagesContract,
  type AttachFile,
  type GenerationTemplateRequest,
  type ModelSelectionRequest,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  getModelProviderFirewall,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { zeroModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-model-providers";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { MODEL_FIRST_SELECTION_PROVIDER_ID } from "../../services/zero-model-selection.service";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { createRunsSchedulesApi } from "./helpers/api-bdd-runs-schedules";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

/**
 * CHAT-02 / RUN-01 / CHAIN-CHAT: the web chat send route end to end.
 *
 * Every Given is constructed through public APIs (Stripe-webhook entitlement,
 * org model provider/policy routes, runner heartbeat/claim, sandbox report
 * webhooks, feature-switch and computer-use host routes) and every Then is a
 * response body, messages page, thread/run read, queue read, claim payload,
 * or captured chat-callback delivery — no database fixtures or row asserts.
 */

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsSchedulesApi(context);
const chat = createChatFilesBddApi(context);
const webhooks = createWebhookCallbackApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const cu = createComputerUseBddApi(context);
const routeMocks = createZeroRouteMocks(context);

type AssistantMessage = Extract<PagedChatMessage, { role: "assistant" }>;
type UserMessage = Extract<PagedChatMessage, { role: "user" }>;
type RunnerClaim = Awaited<ReturnType<typeof api.claimRunnerJob>>;

interface EntitledChatActor {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly providerId: string;
}

interface ChatRunSendBody {
  readonly agentId: string;
  readonly prompt: string;
  readonly threadId?: string;
  readonly clientThreadId?: string;
  readonly clientMessageId?: string;
  readonly modelSelection?: ModelSelectionRequest;
  readonly generationTemplate?: GenerationTemplateRequest;
  readonly attachFiles?: readonly AttachFile[];
  readonly computerUseHostId?: string | null;
  readonly revokesMessageId?: string;
}

const openRouterBodySchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
});

async function entitledChatActor(): Promise<EntitledChatActor> {
  const actor = bdd.user();
  chatCallbacks.acceptChatObjectStorage();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  chatCallbacks.disableVapid();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  const { providerId } = await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "BDD chat messages agent",
    description: "Exercises the web chat send route.",
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, runnerGroup, providerId };
}

async function sendChatRun(
  actor: ApiTestUser,
  body: ChatRunSendBody,
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const sent = await chat.requestSendMessage(actor, body, [201]);
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected the entitled chat send to create a run");
  }
  return { runId: sent.body.runId, threadId: sent.body.threadId };
}

async function claimChatRun(
  runnerGroup: string,
  runId: string,
): Promise<{
  readonly claim: RunnerClaim;
  readonly sandboxHeaders: { readonly authorization: string };
}> {
  await api.heartbeatRunner(runnerGroup);
  const claim = await api.claimRunnerJob(runId);
  return {
    claim,
    sandboxHeaders: { authorization: `Bearer ${claim.sandboxToken}` },
  };
}

function claimEnvironment(claim: RunnerClaim): Record<string, string> {
  if (!claim.environment) {
    throw new Error("Expected the runner claim to carry an environment");
  }
  return claim.environment;
}

/** Sandbox-scoped zero token issued to the run, exposed via the claim env. */
function zeroTokenFromClaim(claim: RunnerClaim): string {
  const token = claimEnvironment(claim).ZERO_TOKEN;
  if (!token || !token.startsWith("vm0_sandbox_")) {
    throw new Error("Expected the claim environment to carry a ZERO_TOKEN");
  }
  return token;
}

async function waitForThreadMessages(
  actor: ApiTestUser,
  threadId: string,
  predicate: (messages: readonly PagedChatMessage[]) => boolean,
) {
  let page: Awaited<ReturnType<typeof chat.listThreadMessages>> | undefined;
  await expect
    .poll(async () => {
      page = await chat.listThreadMessages(actor, threadId);
      return predicate(page.messages);
    })
    .toBe(true);
  if (!page) {
    throw new Error(`Expected chat thread ${threadId} messages to be readable`);
  }
  return page;
}

async function waitForRunStatus(
  actor: ApiTestUser,
  runId: string,
  status: "cancelled" | "completed" | "failed" | "pending" | "running",
): Promise<void> {
  await expect
    .poll(async () => {
      const run = await api.readRun(actor, runId);
      return run.status;
    })
    .toBe(status);
}

async function waitForThreadTitle(
  actor: ApiTestUser,
  threadId: string,
  title: string | null,
): Promise<void> {
  await expect
    .poll(async () => {
      return (await chat.readThread(actor, threadId)).title;
    })
    .toBe(title);
}

/**
 * Checkpoint + exitCode-0 complete (completing without a checkpoint fails the
 * run).
 */
async function completeChatRunOk(
  runId: string,
  sandboxHeaders: { readonly authorization: string },
  options: { readonly lastEventSequence?: number } = {},
): Promise<void> {
  const historyHash = createHash("sha256")
    .update(`bdd chat session history ${runId}`)
    .digest("hex");
  await webhooks.requestAgentCheckpoint(
    {
      runId,
      cliAgentType: "claude-code",
      cliAgentSessionId: `bdd-cli-${runId}`,
      cliAgentSessionHistoryHash: historyHash,
    },
    sandboxHeaders,
    [200],
  );
  await webhooks.requestAgentComplete(
    {
      runId,
      exitCode: 0,
      ...(options.lastEventSequence === undefined
        ? {}
        : { lastEventSequence: options.lastEventSequence }),
    },
    sandboxHeaders,
    [200],
  );
}

async function failChatRun(
  runId: string,
  sandboxHeaders: { readonly authorization: string },
  error: string,
): Promise<void> {
  await webhooks.requestAgentComplete(
    { runId, exitCode: 1, error },
    sandboxHeaders,
    [200],
  );
}

async function cancelChatRun(actor: ApiTestUser, runId: string): Promise<void> {
  await api.requestCancelRun(actor, runId, [200]);
  await waitForRunStatus(actor, runId, "cancelled");
}

function assistantMessages(
  messages: readonly PagedChatMessage[],
): AssistantMessage[] {
  return messages.flatMap((message) => {
    return message.role === "assistant" ? [message] : [];
  });
}

function userMessages(messages: readonly PagedChatMessage[]): UserMessage[] {
  return messages.flatMap((message) => {
    return message.role === "user" ? [message] : [];
  });
}

function eventBackedContents(
  messages: readonly PagedChatMessage[],
  runId: string,
): AssistantMessage[] {
  return assistantMessages(messages).filter((message) => {
    return (
      message.runId === runId &&
      message.content !== null &&
      message.runLifecycleEvent === undefined
    );
  });
}

function assistantEvent(
  sequenceNumber: number,
  text: string,
): Record<string, unknown> {
  return {
    eventType: "assistant",
    sequenceNumber,
    eventData: { message: { content: [{ type: "text", text }] } },
  };
}

function modelProviderSecretPlaceholder(
  type: ModelProviderType,
  secretName: string,
): string {
  const placeholder =
    getModelProviderFirewall(type)?.placeholders?.[secretName];
  if (!placeholder) {
    throw new Error(`Missing model provider placeholder for ${secretName}`);
  }
  return placeholder;
}

function modelProvidersClient() {
  return setupApp({ context })(zeroModelProvidersMainContract);
}

function chatMessagesClient() {
  return setupApp({ context })(chatMessagesContract);
}

function sessionHeaders(actor: ApiTestUser): {
  readonly authorization: string;
} {
  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

/** Org-admin model provider upsert through the public route. */
async function upsertOrgModelProvider(
  actor: ApiTestUser,
  body: {
    readonly type: "anthropic-api-key" | "deepseek-api-key" | "vm0";
    readonly secret?: string;
  },
): Promise<{ readonly providerId: string; readonly created: boolean }> {
  const response = await accept(
    modelProvidersClient().upsert({
      headers: sessionHeaders(actor),
      body,
    }),
    [200, 201],
  );
  return {
    providerId: response.body.provider.id,
    created: response.body.created,
  };
}

async function updateFeatureSwitches(
  actor: ApiTestUser,
  switches: Partial<Record<FeatureSwitchKey, boolean>>,
): Promise<void> {
  await accept(
    setupApp({ context })(zeroFeatureSwitchesContract).update({
      headers: sessionHeaders(actor),
      body: { switches },
    }),
    [200],
  );
}

async function disableComputerUse(actor: ApiTestUser): Promise<void> {
  await updateFeatureSwitches(actor, { [FeatureSwitchKey.ComputerUse]: false });
}

/**
 * Raw chat send through the Hono app, for statuses the ts-rest contract does
 * not model (precedent: requestListAutomationsRaw in api-bdd-runs-schedules).
 */
async function requestSendMessageRaw(
  actor: ApiTestUser,
  body: ChatRunSendBody,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const headers = sessionHeaders(actor);
  const app = createApp({ signal: context.signal });
  const response = await app.request("/api/zero/chat/messages", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const responseBody: unknown = await response.json();
  return { status: response.status, body: responseBody };
}

/** Chat send authenticated by a run-scoped sandbox bearer token. */
async function requestSendMessageWithBearer(
  token: string,
  body: { readonly agentId: string; readonly prompt: string },
  statuses: readonly (201 | 401 | 403)[],
) {
  return await accept(
    chatMessagesClient().send({
      headers: { authorization: `Bearer ${token}` },
      body,
    }),
    statuses,
  );
}

describe("CHAT-02: web chat send and client-id idempotency", () => {
  it("creates a web chat run and replays client ids idempotently", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.proxyChatCallbackToApp();

    const clientThreadId = randomUUID();
    const clientMessageId = randomUUID();
    const prompt = "hello from bdd web chat";
    const first = await chat.requestSendMessage(
      actor,
      { agentId, prompt, clientThreadId, clientMessageId },
      [201],
    );
    if (first.status !== 201 || first.body.runId === null) {
      throw new Error("Expected the first chat send to create a run");
    }
    expect(first.body.threadId).toBe(clientThreadId);
    expect(first.body.status).toBe("pending");
    const runId = first.body.runId;

    const run = await api.readRun(actor, runId);
    expect(run.prompt).toBe(prompt);
    expect(run.appendSystemPrompt).toContain(
      "You are currently running inside: Web",
    );
    expect(run.appendSystemPrompt).not.toContain("# Generation Template");

    const messages = await waitForThreadMessages(
      actor,
      clientThreadId,
      (items) => {
        return userMessages(items).length === 1;
      },
    );
    expect(userMessages(messages.messages)).toHaveLength(1);
    expect(userMessages(messages.messages)[0]).toMatchObject({
      id: clientMessageId,
      content: prompt,
      runId,
    });

    const threads = await chat.listThreads(actor);
    expect(
      [...threads.pinned, ...threads.threads].map((thread) => {
        return thread.id;
      }),
    ).toContain(clientThreadId);

    // Identical retry resolves through the associated client message.
    const retry = await chat.requestSendMessage(
      actor,
      { agentId, prompt, clientThreadId, clientMessageId },
      [201],
    );
    expect(retry.body).toStrictEqual(first.body);

    // Same client thread with a fresh client message id resolves to the
    // thread's first run instead of creating a second one.
    const threadRetry = await chat.requestSendMessage(
      actor,
      {
        agentId,
        prompt: "retried after losing the response",
        clientThreadId,
        clientMessageId: randomUUID(),
      },
      [201],
    );
    if (threadRetry.status !== 201) {
      throw new Error("Expected the client-thread retry to resolve");
    }
    expect(threadRetry.body.runId).toBe(runId);
    const afterRetries = await chat.listThreadMessages(actor, clientThreadId);
    expect(userMessages(afterRetries.messages)).toHaveLength(1);

    const { sandboxHeaders } = await claimChatRun(runnerGroup, runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(runId, sandboxHeaders);

    const completedRetry = await chat.requestSendMessage(
      actor,
      { agentId, prompt, clientThreadId, clientMessageId },
      [201],
    );
    expect(completedRetry.body).toStrictEqual({
      ...first.body,
      status: "completed",
    });

    // A pre-created client thread with no runs cannot be replayed into.
    const emptyClientThreadId = randomUUID();
    const created = await chat.createThread(actor, {
      agentId,
      title: "Pre-created client thread",
      clientThreadId: emptyClientThreadId,
    });
    expect(created.id).toBe(emptyClientThreadId);
    const emptyRetry = await chat.requestSendMessage(
      actor,
      {
        agentId,
        prompt: "send into the pre-created thread",
        clientThreadId: emptyClientThreadId,
      },
      [400],
    );
    expectApiError(emptyRetry.body);
    expect(emptyRetry.body.error.message).toBe(
      "Client thread id is already in use",
    );
  }, 90_000);

  it("adds chat stream context only for opted-in web chat sends", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.proxyChatCallbackToApp();

    const disabled = await sendChatRun(actor, {
      agentId,
      prompt: "streaming disabled web chat",
    });
    const disabledClaim = await claimChatRun(runnerGroup, disabled.runId);
    expect(disabledClaim.claim).not.toHaveProperty("chatStreamChannel");
    expect(disabledClaim.claim).not.toHaveProperty("chatStreamTopic");
    expect(disabledClaim.claim).not.toHaveProperty("chatStreamToken");
    expect(context.mocks.ably.requestToken).not.toHaveBeenCalled();
    await cancelChatRun(actor, disabled.runId);

    context.mocks.ably.requestToken.mockResolvedValueOnce({
      token: "stream-token",
    });
    await updateFeatureSwitches(actor, {
      [FeatureSwitchKey.AssistantTextStreaming]: true,
    });

    const enabled = await sendChatRun(actor, {
      agentId,
      prompt: "streaming enabled web chat",
    });
    const enabledClaim = await claimChatRun(runnerGroup, enabled.runId);
    expect(enabledClaim.claim).toMatchObject({
      chatStreamChannel: `user:${actor.userId}`,
      chatStreamTopic: `chatThreadMessageDelta:${enabled.threadId}`,
      chatStreamToken: "stream-token",
    });
    expect(context.mocks.ably.requestToken).toHaveBeenCalledWith({
      capability: JSON.stringify({
        [`user:${actor.userId}`]: ["publish"],
      }),
      ttl: 24 * 60 * 60 * 1000,
      clientId: undefined,
    });
    await cancelChatRun(actor, enabled.runId);
  }, 90_000);

  it("rejects unauthenticated, unknown-agent, and foreign private-agent sends", async () => {
    const unauthenticated = await chat.requestSendMessage(
      null,
      { agentId: randomUUID(), prompt: "hello" },
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "Private chat-send guard agent",
      visibility: "private",
    });

    const unknownAgent = await chat.requestSendMessage(
      actor,
      { agentId: randomUUID(), prompt: "hello" },
      [404],
    );
    expectApiError(unknownAgent.body);
    expect(unknownAgent.body.error.code).toBe("NOT_FOUND");

    const peer = bdd.user({ orgId: actor.orgId });
    const forbidden = await chat.requestSendMessage(
      peer,
      { agentId: agent.agentId, prompt: "hello" },
      [403],
    );
    expectApiError(forbidden.body);
    expect(forbidden.body.error.message).toBe(
      "Only the private agent owner can run this agent",
    );
  }, 30_000);
});

describe("CHAT-02: interrupting active chat runs", () => {
  it("interrupts an active run, guards interrupt ids, and feeds cancelled rounds into the next run", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.proxyChatCallbackToApp();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "long task to interrupt",
    });

    const interruptId = randomUUID();
    const interrupted = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: first.threadId,
        interruptsRunId: first.runId,
        clientMessageId: interruptId,
      },
      [201],
    );
    if (interrupted.status !== 201) {
      throw new Error("Expected the interrupt send to be accepted");
    }
    expect(interrupted.body.runId).toBeNull();
    await waitForRunStatus(actor, first.runId, "cancelled");

    const messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (items) => {
        return (
          userMessages(items).some((message) => {
            return message.interruptsRunId === first.runId;
          }) &&
          assistantMessages(items).some((message) => {
            return (
              message.runId === first.runId &&
              message.runLifecycleEvent === "cancelled"
            );
          })
        );
      },
    );
    const interruptRows = userMessages(messages.messages).filter((message) => {
      return message.interruptsRunId === first.runId;
    });
    expect(interruptRows).toHaveLength(1);
    expect(interruptRows[0]).toMatchObject({ id: interruptId, content: null });
    expect(
      assistantMessages(messages.messages).filter((message) => {
        return (
          message.runId === first.runId &&
          message.runLifecycleEvent === "cancelled"
        );
      }),
    ).toHaveLength(1);

    // Replaying the interrupt (same or fresh client id) stays idempotent.
    const replayedInterrupt = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: first.threadId,
        interruptsRunId: first.runId,
        clientMessageId: interruptId,
      },
      [201],
    );
    expect(replayedInterrupt.body).toMatchObject({
      runId: null,
      threadId: first.threadId,
    });
    await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: first.threadId,
        interruptsRunId: first.runId,
        clientMessageId: randomUUID(),
      },
      [201],
    );
    const afterReplays = await chat.listThreadMessages(actor, first.threadId);
    expect(
      userMessages(afterReplays.messages).filter((message) => {
        return message.interruptsRunId === first.runId;
      }),
    ).toHaveLength(1);

    // A run that went terminal without an interrupt row cannot be interrupted.
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "cancelled through the cancel api",
    });
    await cancelChatRun(actor, second.runId);
    const lateInterrupt = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: first.threadId,
        interruptsRunId: second.runId,
        clientMessageId: randomUUID(),
      },
      [400],
    );
    expectApiError(lateInterrupt.body);
    expect(lateInterrupt.body.error.message).toBe(
      "Only active chat runs can be interrupted",
    );

    // The interrupt's client message id is burned for normal sends.
    const reusedInterruptId = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "reuse the interrupt client id",
        clientMessageId: interruptId,
      },
      [409],
    );
    expectApiError(reusedInterruptId.body);
    expect(reusedInterruptId.body.error.message).toBe(
      "clientMessageId is already in use",
    );

    // Both cancelled rounds surface as incomplete context for the next run.
    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "resume after interruptions",
    });
    const thirdRun = await api.readRun(actor, third.runId);
    const appended = thirdRun.appendSystemPrompt ?? "";
    expect(appended).toContain("# Incomplete Rounds Context");
    expect(appended).toContain("RUN_STATUS: cancelled");
    expect(appended).toContain("User: long task to interrupt");
    expect(appended).not.toContain("# Web Chat Run Context");
    await cancelChatRun(actor, third.runId);
  }, 90_000);
});

describe("CHAT-02: queueing and recalling messages", () => {
  it("queues, retries, and recalls messages behind an active run", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.proxyChatCallbackToApp();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "anchor active run",
    });

    const queuedId = randomUUID();
    const queued = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "queued behind the active run",
        clientMessageId: queuedId,
      },
      [201],
    );
    if (queued.status !== 201) {
      throw new Error("Expected the queued send to be accepted");
    }
    expect(queued.body.runId).toBeNull();
    const queuedRetry = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "queued behind the active run",
        clientMessageId: queuedId,
      },
      [201],
    );
    expect(queuedRetry.body).toStrictEqual(queued.body);

    const beforeRecall = await chat.listThreadMessages(actor, first.threadId);
    expect(
      userMessages(beforeRecall.messages).filter((message) => {
        return message.id === queuedId;
      }),
    ).toHaveLength(1);

    const recallId = randomUUID();
    const recalled = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: first.threadId,
        revokesMessageId: queuedId,
        clientMessageId: recallId,
      },
      [201],
    );
    if (recalled.status !== 201) {
      throw new Error("Expected the recall send to be accepted");
    }
    expect(recalled.body.runId).toBeNull();
    const afterRecall = await chat.listThreadMessages(actor, first.threadId);
    const recallRows = userMessages(afterRecall.messages).filter((message) => {
      return message.revokesMessageId === queuedId;
    });
    expect(recallRows).toHaveLength(1);
    expect(recallRows[0]).toMatchObject({ id: recallId, content: null });

    const repeatedRecall = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: first.threadId,
        revokesMessageId: queuedId,
        clientMessageId: randomUUID(),
      },
      [201],
    );
    expect(repeatedRecall.body).toMatchObject({
      runId: null,
      threadId: first.threadId,
    });
    const afterRepeated = await chat.listThreadMessages(actor, first.threadId);
    expect(
      userMessages(afterRepeated.messages).filter((message) => {
        return message.revokesMessageId === queuedId;
      }),
    ).toHaveLength(1);

    // Run-associated messages cannot be recalled.
    const associated = userMessages(afterRepeated.messages).find((message) => {
      return message.runId === first.runId;
    });
    if (!associated) {
      throw new Error("Expected the active run's user message to be listed");
    }
    const rejectedRecall = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: first.threadId,
        revokesMessageId: associated.id,
        clientMessageId: randomUUID(),
      },
      [400],
    );
    expectApiError(rejectedRecall.body);
    expect(rejectedRecall.body.error.message).toBe(
      "Only queued user messages can be recalled",
    );

    // The recall's client message id is burned for normal sends.
    const reusedRecallId = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "reuse the recall client id",
        clientMessageId: recallId,
      },
      [409],
    );
    expectApiError(reusedRecallId.body);
    expect(reusedRecallId.body.error.message).toBe(
      "clientMessageId is already in use",
    );

    // Another user's send cannot claim the queued message's client id.
    const stranger = bdd.user();
    const strangerAgent = await bdd.createAgent(stranger, {
      displayName: "Cross-user client-id agent",
    });
    const strangerThread = await chat.createThread(stranger, {
      agentId: strangerAgent.agentId,
      title: "Cross-user conflict thread",
    });
    const crossUser = await chat.requestSendMessage(
      stranger,
      {
        agentId: strangerAgent.agentId,
        threadId: strangerThread.id,
        prompt: "cross-user retry",
        clientMessageId: queuedId,
      },
      [409],
    );
    expectApiError(crossUser.body);
    expect(crossUser.body.error.message).toBe(
      "clientMessageId is already in use",
    );
    const strangerMessages = await chat.listThreadMessages(
      stranger,
      strangerThread.id,
    );
    expect(strangerMessages.messages).toStrictEqual([]);
    const ownerMessages = await chat.listThreadMessages(actor, first.threadId);
    expect(
      ownerMessages.messages.some((message) => {
        return message.content === "cross-user retry";
      }),
    ).toBeFalsy();

    await cancelChatRun(actor, first.runId);
    expect((await api.readRun(actor, first.runId)).status).toBe("cancelled");
  }, 90_000);
});

describe("CHAT-02: org queue markers", () => {
  it("marks queued chat runs and revokes the marker on dequeue", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.proxyChatCallbackToApp();
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");

    const blocker = await chat.requestSendMessage(
      actor,
      { agentId, prompt: "occupy org concurrency" },
      [201],
    );
    if (blocker.status !== 201 || blocker.body.runId === null) {
      throw new Error("Expected the blocking send to create a run");
    }
    expect(blocker.body.status).toBe("pending");

    const queuedRun = await chat.requestSendMessage(
      actor,
      { agentId, prompt: "wait behind the active run" },
      [201],
    );
    if (queuedRun.status !== 201 || queuedRun.body.runId === null) {
      throw new Error("Expected the second send to create a queued run");
    }
    expect(queuedRun.body.status).toBe("queued");

    const queuedThread = queuedRun.body.threadId;
    const beforeDequeue = await waitForThreadMessages(
      actor,
      queuedThread,
      (items) => {
        return (
          userMessages(items).length === 1 &&
          assistantMessages(items).some((message) => {
            return message.runEventId === "queue:queued";
          })
        );
      },
    );
    expect(userMessages(beforeDequeue.messages)).toHaveLength(1);
    expect(userMessages(beforeDequeue.messages)[0]).toMatchObject({
      content: "wait behind the active run",
      runId: queuedRun.body.runId,
    });
    const marker = assistantMessages(beforeDequeue.messages).find((message) => {
      return message.runEventId === "queue:queued";
    });
    if (!marker) {
      throw new Error("Expected an assistant queue marker");
    }
    expect(marker).toMatchObject({
      content: "Waiting in queue...",
      runId: queuedRun.body.runId,
    });

    // The queued run still counts as the thread's active run, so a template
    // send queues as an unassociated message carrying its template.
    const template = PRESENTATION_TEMPLATE_ITEMS[0];
    if (!template) {
      throw new Error("Expected a registered presentation template");
    }
    const generationTemplate: GenerationTemplateRequest = {
      type: "presentation",
      selection: {
        designSystemId: template.designSystemId,
        templateId: template.templateId,
      },
    };
    const templateMessageId = randomUUID();
    const queuedTemplate = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: queuedThread,
        prompt: "template queued deck",
        generationTemplate,
        clientMessageId: templateMessageId,
      },
      [201],
    );
    expect(queuedTemplate.body).toMatchObject({ runId: null });
    const withTemplate = await chat.listThreadMessages(actor, queuedThread);
    const templateMessage = userMessages(withTemplate.messages).find(
      (message) => {
        return message.id === templateMessageId;
      },
    );
    expect(templateMessage?.generationTemplate).toStrictEqual(
      generationTemplate,
    );

    const queueBefore = await api.readRunQueue(actor);
    expect(queueBefore.body.queue).toHaveLength(1);
    expect(queueBefore.body.queue[0]).toMatchObject({
      runId: queuedRun.body.runId,
    });

    // Recall the queued template message so the dequeue does not auto-send it.
    await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: queuedThread,
        revokesMessageId: templateMessageId,
        clientMessageId: randomUUID(),
      },
      [201],
    );

    // Interrupting the blocking run drains the org queue and revokes the
    // queue marker on the dequeued run's thread.
    await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: blocker.body.threadId,
        interruptsRunId: blocker.body.runId,
        clientMessageId: randomUUID(),
      },
      [201],
    );

    await waitForRunStatus(actor, blocker.body.runId, "cancelled");
    await waitForRunStatus(actor, queuedRun.body.runId, "pending");
    const afterDequeue = await waitForThreadMessages(
      actor,
      queuedThread,
      (items) => {
        return assistantMessages(items).some((message) => {
          return message.runEventId === "queue:dequeued";
        });
      },
    );
    const revoker = assistantMessages(afterDequeue.messages).find((message) => {
      return message.runEventId === "queue:dequeued";
    });
    if (!revoker) {
      throw new Error("Expected an assistant queue-dequeued revoker");
    }
    expect(revoker).toMatchObject({
      content: null,
      runId: queuedRun.body.runId,
      revokesMessageId: marker.id,
    });
    const queueAfter = await api.readRunQueue(actor);
    expect(queueAfter.body.queue).toHaveLength(0);

    await cancelChatRun(actor, queuedRun.body.runId);
    expect((await api.readRun(actor, queuedRun.body.runId)).status).toBe(
      "cancelled",
    );
  }, 90_000);
});

describe("CHAT-02: dispatch failure", () => {
  it("fails the run and delivers the terminal chat callback when dispatch cannot start", async () => {
    const { actor, agentId } = await entitledChatActor();
    const deliveries = chatCallbacks.proxyChatCallbackToApp();
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", undefined);

    const sent = await chat.requestSendMessage(
      actor,
      { agentId, prompt: "fail before worker start" },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected the failed dispatch to still create a run");
    }
    expect(sent.body.status).toBe("failed");

    const run = await api.readRun(actor, sent.body.runId);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("RUNNER_DEFAULT_GROUP");

    // The terminal chat callback is dispatched after the response returns,
    // so poll until the delivery has been captured before asserting on it.
    await expect
      .poll(() => {
        return deliveries.length;
      })
      .toBe(1);
    const delivery: unknown = JSON.parse(deliveries[0]?.body ?? "{}");
    expect(delivery).toMatchObject({
      runId: sent.body.runId,
      status: "failed",
      payload: { threadId: sent.body.threadId, agentId },
    });

    const messages = await waitForThreadMessages(
      actor,
      sent.body.threadId,
      (items) => {
        return assistantMessages(items).some((message) => {
          return (
            message.runId === sent.body.runId &&
            message.runLifecycleEvent === "failed"
          );
        });
      },
    );
    const failedMarker = assistantMessages(messages.messages).find(
      (message) => {
        return (
          message.runId === sent.body.runId &&
          message.runLifecycleEvent === "failed"
        );
      },
    );
    if (!failedMarker) {
      throw new Error("Expected a failed lifecycle marker");
    }
    expect(failedMarker.error).toStrictEqual(expect.any(String));
  }, 60_000);
});

describe("CHAT-02: admission without spendable credits", () => {
  it("blocks admission for provider-pinned sends through visible chat messages", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    await bdd.setupOnboarding(actor, {
      displayName: "BDD pro-suspend admission agent",
    });
    const agent = await bdd.createAgent(actor, {
      displayName: "Pro-suspend chat agent",
    });
    const { providerId } = await upsertOrgModelProvider(actor, {
      type: "vm0",
    });

    const clientMessageId = randomUUID();
    const sendBody: ChatRunSendBody = {
      agentId: agent.agentId,
      prompt: "blocked by suspended plan",
      modelSelection: {
        modelProviderId: providerId,
        selectedModel: "claude-sonnet-4-6",
      },
      clientMessageId,
    };
    const sent = await chat.requestSendMessage(actor, sendBody, [201]);
    if (sent.status !== 201) {
      throw new Error("Expected the blocked send to return 201 without a run");
    }
    expect(sent.body.runId).toBeNull();

    const messages = await chat.listThreadMessages(actor, sent.body.threadId);
    const blockedUser = userMessages(messages.messages)[0];
    expect(blockedUser).toMatchObject({
      id: clientMessageId,
      content: "blocked by suspended plan",
      error: "insufficient_credits",
    });
    expect(blockedUser?.runId).toBeUndefined();
    const guidance = assistantMessages(messages.messages)[0];
    expect(guidance?.content).toContain("Upgrade to Pro");
    expect(guidance?.error).toBe("insufficient_credits");

    const queue = await api.readRunQueue(actor);
    expect(queue.body.queue).toHaveLength(0);
    expect(queue.body.concurrency.active).toBe(0);

    const retry = await chat.requestSendMessage(
      actor,
      { ...sendBody, threadId: sent.body.threadId },
      [201],
    );
    expect(retry.body).toStrictEqual(sent.body);
    const afterRetry = await chat.listThreadMessages(actor, sent.body.threadId);
    expect(afterRetry.messages).toHaveLength(2);
  }, 60_000);
});

describe("CHAT-02: explicit provider pins", () => {
  it("routes explicit provider pins into the runner claim", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.proxyChatCallbackToApp();
    const { providerId: deepseekId } = await upsertOrgModelProvider(actor, {
      type: "deepseek-api-key",
      secret: "selected-deepseek-key",
    });

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "run with the selected deepseek provider",
      modelSelection: {
        modelProviderId: deepseekId,
        selectedModel: "deepseek-v4-pro",
      },
    });

    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    const environment = claimEnvironment(claim);
    expect(environment.ANTHROPIC_AUTH_TOKEN).toBe(
      modelProviderSecretPlaceholder("deepseek-api-key", "DEEPSEEK_API_KEY"),
    );
    expect(environment.ANTHROPIC_BASE_URL).toBe(
      "https://api.deepseek.com/anthropic",
    );
    expect(environment.ANTHROPIC_MODEL).toBe("deepseek-v4-pro");
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();

    // Explicit pins persist on the thread as model-only state.
    const thread = await chat.readThread(actor, run.threadId);
    expect(thread.selectedModel).toBe("deepseek-v4-pro");
    expect(thread.modelProviderId ?? null).toBeNull();

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(run.runId, sandboxHeaders);
    expect((await api.readRun(actor, run.runId)).status).toBe("completed");

    // A vm0 provider pin in an entitled org passes the spendable-credits
    // admission. The outcome past admission is race-dependent on the shared
    // database: 503 when no vm0 execution key exists (no public provisioning
    // surface), 201 when another suite's alive legacy test has seeded a
    // global vm0 key. Both prove the credits-ok admission arm.
    const { providerId: vm0Id } = await upsertOrgModelProvider(actor, {
      type: "vm0",
    });
    const vm0Send = await requestSendMessageRaw(actor, {
      agentId,
      prompt: "vm0-backed admission with spendable credits",
      modelSelection: {
        modelProviderId: vm0Id,
        selectedModel: "claude-sonnet-4-6",
      },
    });
    expect([201, 503]).toContain(vm0Send.status);
    if (vm0Send.status === 503) {
      expectApiError(vm0Send.body);
      expect(vm0Send.body.error.message).toContain(
        "No model provider configured",
      );
    } else {
      const vm0Body = vm0Send.body as { readonly runId: string | null };
      if (vm0Body.runId !== null) {
        await api.requestCancelRun(actor, vm0Body.runId, [200]);
      }
    }
  }, 90_000);
});

describe("CHAT-02: server-side model switches", () => {
  it("switches models server-side and starts a fresh session with prior web context", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.proxyChatCallbackToApp();
    await chatCallbacks.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-4-6",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "claude-sonnet-4-6",
        isDefault: false,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const firstPrompt = "first turn on the default opus policy";
    const first = await sendChatRun(actor, { agentId, prompt: firstPrompt });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    expect(claimEnvironment(firstClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-opus-4-6",
    );
    chatCallbacks.mockChatOutputEvents([assistantEvent(0, "opus answer")]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });
    await waitForThreadMessages(actor, first.threadId, (items) => {
      return eventBackedContents(items, first.runId).some((message) => {
        return message.content === "opus answer";
      });
    });
    expect((await chat.readThread(actor, first.threadId)).selectedModel).toBe(
      "claude-opus-4-6",
    );
    expect(
      (await api.readRun(actor, first.runId)).result?.agentSessionId,
    ).toMatch(/[0-9a-f-]{36}/);

    // Sentinel selection of another model starts a fresh session that carries
    // the prior web round as context instead of resuming the CLI session.
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "switch to sonnet",
      modelSelection: {
        modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
        selectedModel: "claude-sonnet-4-6",
      },
    });
    const secondRun = await api.readRun(actor, second.runId);
    const appended = secondRun.appendSystemPrompt ?? "";
    expect(appended).toContain("# Web Chat Run Context");
    expect(appended).toContain(`- RUN_ID: ${first.runId}`);
    expect(appended).toContain(`- LOG_COMMAND: zero logs ${first.runId} --all`);
    expect(appended).toContain(`User: ${firstPrompt}`);
    expect(appended).toContain("Assistant: opus answer");
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.resumeSession).toBeNull();
    expect(claimEnvironment(secondClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-sonnet-4-6",
    );
    expect((await chat.readThread(actor, first.threadId)).selectedModel).toBe(
      "claude-sonnet-4-6",
    );
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(second.runId, secondClaim.sandboxHeaders);

    // Same-model follow-ups resume the previous turn's CLI session.
    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue on sonnet",
    });
    const thirdClaim = await claimChatRun(runnerGroup, third.runId);
    expect(thirdClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${second.runId}`,
    );
    await cancelChatRun(actor, third.runId);

    // The sentinel selection also became the user's model preference, so a
    // fresh thread without a selection pins the preferred model.
    const fourth = await sendChatRun(actor, {
      agentId,
      prompt: "fresh thread uses the sentinel preference",
    });
    expect((await chat.readThread(actor, fourth.threadId)).selectedModel).toBe(
      "claude-sonnet-4-6",
    );
    await cancelChatRun(actor, fourth.runId);
  }, 90_000);

  it("re-resolves the provider route from current policy on follow-up sends", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.proxyChatCallbackToApp();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "pin sonnet model-first",
      modelSelection: {
        modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
        selectedModel: "claude-sonnet-4-6",
      },
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    const pinned = await chat.readThread(actor, first.threadId);
    expect(pinned.selectedModel).toBe("claude-sonnet-4-6");
    expect(pinned.modelProviderId ?? null).toBeNull();

    // Org providers are per-type singletons, so the public rotation surface
    // is re-upserting the same provider with a new secret. The model-only
    // thread pin re-resolves the policy route on every follow-up send.
    const rotated = await upsertOrgModelProvider(actor, {
      type: "anthropic-api-key",
      secret: "rotated-anthropic-key",
    });
    expect(rotated).toStrictEqual({ providerId, created: false });

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "follow up after the provider rotation",
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    const environment = claimEnvironment(secondClaim.claim);
    expect(environment.ANTHROPIC_API_KEY).toBe(
      modelProviderSecretPlaceholder("anthropic-api-key", "ANTHROPIC_API_KEY"),
    );
    expect(environment.ANTHROPIC_MODEL).toBe("claude-sonnet-4-6");
    expect(secondClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );
    const after = await chat.readThread(actor, first.threadId);
    expect(after.selectedModel).toBe("claude-sonnet-4-6");
    expect(after.modelProviderId ?? null).toBeNull();
    await cancelChatRun(actor, second.runId);
  }, 90_000);

  it("rejects invalid model selections without creating visible state", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "Invalid model selection agent",
    });

    // A provider id from another workspace is unknown here.
    const outsider = bdd.user();
    const foreign = await upsertOrgModelProvider(outsider, {
      type: "anthropic-api-key",
      secret: "foreign-org-key",
    });
    const foreignThreadId = randomUUID();
    const foreignPin = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        prompt: "use a foreign provider",
        clientThreadId: foreignThreadId,
        modelSelection: {
          modelProviderId: foreign.providerId,
          selectedModel: "claude-sonnet-4-6",
        },
      },
      [400],
    );
    expectApiError(foreignPin.body);
    expect(foreignPin.body.error.message).toBe(
      "Unknown model provider for this workspace",
    );
    await chat.requestReadThread(actor, foreignThreadId, [404]);

    // A vm0 provider pin only accepts supported run models.
    const vm0Provider = await upsertOrgModelProvider(actor, { type: "vm0" });
    const vm0ThreadId = randomUUID();
    const invalidVm0Model = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        prompt: "use an unsupported vm0 model",
        clientThreadId: vm0ThreadId,
        modelSelection: {
          modelProviderId: vm0Provider.providerId,
          selectedModel: "codex",
        },
      },
      [400],
    );
    expectApiError(invalidVm0Model.body);
    expect(invalidVm0Model.body.error.message).toBe("Invalid model selection");
    await chat.requestReadThread(actor, vm0ThreadId, [404]);

    // Removed sentinel models fail contract validation.
    for (const selectedModel of [
      "claude-haiku-4-5",
      "anthropic/claude-haiku-4.5",
    ]) {
      const removedThreadId = randomUUID();
      const removed = await chat.requestSendMessage(
        actor,
        {
          agentId: agent.agentId,
          prompt: `removed ${selectedModel}`,
          clientThreadId: removedThreadId,
          modelSelection: {
            modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
            selectedModel,
          },
        },
        [400],
      );
      expectApiError(removed.body);
      expect(removed.body.error).toMatchObject({
        code: "BAD_REQUEST",
        message: "modelSelection.selectedModel: Invalid model selection",
      });
      await chat.requestReadThread(actor, removedThreadId, [404]);
    }

    const threads = await chat.listThreads(actor);
    expect(threads.pinned).toHaveLength(0);
    expect(threads.threads).toHaveLength(0);
  }, 60_000);
});

describe("CHAT-02: incomplete-round context", () => {
  it("injects incomplete rounds and truncates old content chronologically", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    // Callbacks are captured (not delivered), so the failed rounds carry no
    // assistant rows and the context renders the no-response placeholder.
    chatCallbacks.captureChatCallbackDeliveries();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "first incomplete",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    await failChatRun(first.runId, firstClaim.sandboxHeaders, "boom one");

    const longPrompt = `second ${"x".repeat(4100)}`;
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: longPrompt,
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    await failChatRun(second.runId, secondClaim.sandboxHeaders, "boom two");

    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "retry after two failures",
    });
    const thirdRun = await api.readRun(actor, third.runId);
    const appended = thirdRun.appendSystemPrompt ?? "";
    expect(appended).toContain("# Incomplete Rounds Context");
    expect(appended).not.toContain("# Web Chat Run Context");
    expect(appended.split("RUN_STATUS: failed")).toHaveLength(3);
    expect(appended).toContain("User: first incomplete");
    expect(appended.indexOf("User: first incomplete")).toBeLessThan(
      appended.indexOf("User: second"),
    );
    expect(appended).toContain("...[truncated]");
    expect(appended).not.toContain("retry after two failures");
    await cancelChatRun(actor, third.runId);
  }, 90_000);
});

describe("CHAT-02: prior rounds and thread titles", () => {
  it("carries prior completed rounds, generates the thread title, and rejects lifecycle follow-up revokes", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.proxyChatCallbackToApp();
    await chatCallbacks.enableChatRecommendedFollowups(actor);
    mockOptionalEnv("OPENROUTER_API_KEY", "title-key");
    let upstreamAuthorization: string | null = null;
    let titleRequests = 0;
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        async ({ request }) => {
          upstreamAuthorization = request.headers.get("authorization");
          const payload = openRouterBodySchema.parse(await request.json());
          const systemContent = payload.messages[0]?.content ?? "";
          if (
            systemContent.includes(
              "Generate up to three concise follow-up prompts",
            )
          ) {
            return HttpResponse.json({
              choices: [
                {
                  message: {
                    content: JSON.stringify([
                      { prompt: "Summarize the migration steps", kind: "talk" },
                    ]),
                  },
                },
              ],
            });
          }
          if (systemContent.includes("Generate a short, descriptive title")) {
            titleRequests += 1;
            return HttpResponse.json({
              choices: [{ message: { content: "**Migration Plan**" } }],
            });
          }
          return HttpResponse.json({
            choices: [{ message: { content: "Generated summary" } }],
          });
        },
      ),
    );

    const firstPrompt = "plan the API migration";
    const first = await sendChatRun(actor, { agentId, prompt: firstPrompt });
    await waitForThreadTitle(actor, first.threadId, "Migration Plan");
    expect(titleRequests).toBe(1);
    expect(upstreamAuthorization).toBe("Bearer title-key");

    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "Assistant migration answer"),
    ]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });

    const afterFirst = await waitForThreadMessages(
      actor,
      first.threadId,
      (items) => {
        return assistantMessages(items).some((message) => {
          return (message.recommendedFollowups?.length ?? 0) > 0;
        });
      },
    );
    const recommender = assistantMessages(afterFirst.messages).find(
      (message) => {
        return (message.recommendedFollowups?.length ?? 0) > 0;
      },
    );
    if (!recommender) {
      throw new Error("Expected a recommended follow-ups message");
    }
    expect(recommender.runLifecycleEvent).toBe("completed");

    const lifecycleFollowup = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "use the lifecycle follow-up",
        revokesMessageId: recommender.id,
      },
      [400],
    );
    expectApiError(lifecycleFollowup.body);
    expect(lifecycleFollowup.body.error.message).toBe(
      "Recommended follow-up is no longer available",
    );

    const normalRecommender = assistantMessages(afterFirst.messages).find(
      (message) => {
        return (
          message.runLifecycleEvent === undefined &&
          (message.recommendedFollowups?.length ?? 0) > 0
        );
      },
    );
    expect(normalRecommender).toBeUndefined();

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "follow-up question",
    });
    expect((await chat.readThread(actor, first.threadId)).title).toBe(
      "Migration Plan",
    );
    expect(titleRequests).toBe(1);
    const secondRun = await api.readRun(actor, second.runId);
    const appended = secondRun.appendSystemPrompt ?? "";
    expect(appended).toContain("# Web Chat Run Context");
    expect(appended).toContain(`- RUN_ID: ${first.runId}`);
    expect(appended).toContain(`- LOG_COMMAND: zero logs ${first.runId} --all`);
    expect(appended).toContain(`User: ${firstPrompt}`);
    expect(appended).toContain("Assistant: Assistant migration answer");
    expect(appended).toContain("- RELATIVE_INDEX: 0");
    expect(appended).not.toContain("follow-up question");

    await cancelChatRun(actor, second.runId);

    await chat.renameThread(actor, first.threadId, "Manual Migration Title");
    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "manual title should stay",
    });
    expect((await chat.readThread(actor, first.threadId)).title).toBe(
      "Manual Migration Title",
    );
    expect(titleRequests).toBe(1);
    await cancelChatRun(actor, third.runId);
  }, 90_000);
});

describe("CHAT-02: generation templates and attachments", () => {
  it("renders generation template guidance into the run system prompt", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.proxyChatCallbackToApp();
    const template = PRESENTATION_TEMPLATE_ITEMS[0];
    if (!template) {
      throw new Error("Expected a registered presentation template");
    }

    const presentation = await sendChatRun(actor, {
      agentId,
      prompt: "make a launch deck",
      generationTemplate: {
        type: "presentation",
        selection: {
          designSystemId: template.designSystemId,
          templateId: template.templateId,
        },
      },
    });
    const presentationRun = await api.readRun(actor, presentation.runId);
    expect(presentationRun.prompt).toBe("make a launch deck");
    const presentationPrompt = presentationRun.appendSystemPrompt ?? "";
    expect(presentationPrompt).toContain("# Generation Template");
    expect(presentationPrompt).toContain(
      "Use the following registered resources for this run.",
    );
    expect(presentationPrompt).toContain("Type: presentation");
    expect(presentationPrompt).toContain(
      `Design system ID: ${template.designSystemId}`,
    );
    expect(presentationPrompt).toContain(`Template ID: ${template.templateId}`);
    expect(presentationPrompt).toContain("Instructions:");
    expect(presentationPrompt).toContain(
      "- Keep the user's prompt as the source of the requested content.",
    );
    expect(presentationPrompt).toContain("--artifact-kind presentation-html");
    await cancelChatRun(actor, presentation.runId);

    const preset = VIDEO_STYLE_PRESETS.find((item) => {
      return item.id === "tech-minimalist-reveal";
    });
    if (!preset) {
      throw new Error("Expected the tech-minimalist-reveal video preset");
    }
    const video = await sendChatRun(actor, {
      agentId,
      prompt: "make a product video",
      generationTemplate: {
        type: "video",
        selection: { stylePresetId: preset.id },
      },
    });
    const videoRun = await api.readRun(actor, video.runId);
    const videoPrompt = videoRun.appendSystemPrompt ?? "";
    expect(videoPrompt).toContain("# Video Template Preset");
    expect(videoPrompt).toContain(`- Preset name: ${preset.nameEn}`);
    expect(videoPrompt).toContain(
      `- Visual Tone: ${preset.dimensions.visualTone}`,
    );
    expect(videoPrompt).toContain(
      `- Camera Style: ${preset.dimensions.cameraStyle}`,
    );
    expect(videoPrompt).toContain(
      `- Style Reference: ${preset.dimensions.styleReference}`,
    );
    expect(videoPrompt).toContain(
      "safe for all audiences, positive and uplifting, no violence, no explicit content",
    );
    expect(videoPrompt).not.toContain(preset.scene);
    await cancelChatRun(actor, video.runId);
  }, 90_000);

  it("rejects unknown generation template selections", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "Invalid template agent",
    });
    const template = PRESENTATION_TEMPLATE_ITEMS[0];
    if (!template) {
      throw new Error("Expected a registered presentation template");
    }

    const arms: readonly {
      readonly generationTemplate: GenerationTemplateRequest;
      readonly message: string;
    }[] = [
      {
        generationTemplate: {
          type: "presentation",
          selection: {
            designSystemId: template.designSystemId,
            templateId: "template:missing",
          },
        },
        message: "Unknown generation template",
      },
      {
        generationTemplate: {
          type: "presentation",
          selection: {
            designSystemId: "design-system:missing",
            templateId: template.templateId,
          },
        },
        message: "Unknown generation template design system",
      },
      {
        generationTemplate: {
          type: "presentation",
          selection: {
            designSystemId: template.designSystemId,
            templateId: "template:web-prototype-taste-editorial",
          },
        },
        message: "Generation template does not support the requested type",
      },
      {
        generationTemplate: {
          type: "video",
          selection: { stylePresetId: "video-style:missing" },
        },
        message: "Unknown video style preset",
      },
    ];
    for (const arm of arms) {
      const rejected = await chat.requestSendMessage(
        actor,
        {
          agentId: agent.agentId,
          prompt: "make something from a bad template",
          generationTemplate: arm.generationTemplate,
        },
        [400],
      );
      expectApiError(rejected.body);
      expect(rejected.body.error.message).toBe(arm.message);
    }

    const threads = await chat.listThreads(actor);
    expect(threads.pinned).toHaveLength(0);
    expect(threads.threads).toHaveLength(0);
  }, 60_000);

  it("persists attachments and injects them into the run prompt", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.proxyChatCallbackToApp();
    const fileId = randomUUID();
    const filename = "diagram final 100%.png";

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "read this file",
      attachFiles: [
        { id: fileId, filename, contentType: "image/png", size: 42 },
      ],
    });

    const created = await api.readRun(actor, run.runId);
    expect(created.prompt).toContain(`[Web file] ${filename} (image/png)`);
    expect(created.prompt).toContain(`[ID] ${fileId}`);
    expect(created.appendSystemPrompt).toContain("zero web download-file -h");
    expect(created.appendSystemPrompt).toContain("zero web upload-file -h");

    const messages = await waitForThreadMessages(
      actor,
      run.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (message.attachFiles?.length ?? 0) > 0;
        });
      },
    );
    const attached = userMessages(messages.messages)[0]?.attachFiles?.[0];
    expect(attached).toMatchObject({
      id: fileId,
      filename,
      contentType: "image/png",
      size: 42,
      url: expect.stringContaining(`${fileId}/diagram_final_100_.png`),
    });
    await cancelChatRun(actor, run.runId);
  }, 60_000);
});

describe("CHAT-02: queued attachments on auto-send", () => {
  it("carries queued attachments into the auto-sent follow-up run", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.proxyChatCallbackToApp();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "anchor before the queued attachment",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    const fileId = randomUUID();
    const queuedId = randomUUID();
    const queued = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queued with attachment",
        clientMessageId: queuedId,
        attachFiles: [
          {
            id: fileId,
            filename: "notes.txt",
            contentType: "text/plain",
            size: 12,
          },
        ],
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    // Completing the anchor run promotes the queued message into a fresh
    // run whose prompt carries the resolved attachment references.
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesMessageId === queuedId && message.runId !== undefined
          );
        });
      },
    );
    const promoted = userMessages(messages.messages).find((message) => {
      return message.revokesMessageId === queuedId;
    });
    if (!promoted?.runId) {
      throw new Error("Expected the queued message to auto-send into a run");
    }
    expect(promoted.content).toBe("queued with attachment");
    expect(promoted.attachFiles?.[0]).toMatchObject({
      id: fileId,
      filename: "notes.txt",
      contentType: "text/plain",
      size: 12,
      url: expect.stringContaining(`${fileId}/notes.txt`),
    });

    const followUp = await api.readRun(actor, promoted.runId);
    expect(followUp.prompt).toContain("queued with attachment");
    expect(followUp.prompt).toContain("[Web file] notes.txt (text/plain)");
    expect(followUp.prompt).toContain(`[ID] ${fileId}`);
    await cancelChatRun(actor, promoted.runId);
  }, 90_000);
});

describe("CHAT-02/FILE-03: computer-use host grants", () => {
  it("grants computer-use capability only for a selected online host", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.proxyChatCallbackToApp();
    await cu.enableComputerUse(actor);
    const { hostId, hostToken } = await cu.startComputerUseHost(actor);

    // The thread's sticky host is not exposed by any read route, so the
    // grant is observed through the run token issued to each claim: a
    // granted token can create write commands on the host, an ungranted
    // token cannot, and no run token can ever post chat sends.
    const plain = await sendChatRun(actor, {
      agentId,
      prompt: "no computer use selected",
    });
    const plainClaim = await claimChatRun(runnerGroup, plain.runId);
    const plainToken = zeroTokenFromClaim(plainClaim.claim);
    const deniedCommand = await cu.requestCreateComputerUseWriteCommand(
      { bearer: plainToken },
      [403],
    );
    expect(deniedCommand.status).toBe(403);
    const deniedSend = await requestSendMessageWithBearer(
      plainToken,
      { agentId, prompt: "sandbox tokens cannot chat" },
      [403],
    );
    expectApiError(deniedSend.body);
    expect(deniedSend.body.error.message).toContain("agent-run:write");
    await cancelChatRun(actor, plain.runId);

    // Selecting an online host pins it to the thread and grants the run
    // token computer-use write access on that host.
    const granted = await sendChatRun(actor, {
      agentId,
      prompt: "open the remote browser",
      computerUseHostId: hostId,
    });
    const grantedClaim = await claimChatRun(runnerGroup, granted.runId);
    await cu.heartbeatComputerUseHost(hostToken);
    await cu.requestCreateComputerUseWriteCommand(
      { bearer: zeroTokenFromClaim(grantedClaim.claim) },
      [200],
    );
    await cancelChatRun(actor, granted.runId);

    // Follow-up sends without the field stay granted via the sticky host.
    const sticky = await sendChatRun(actor, {
      agentId,
      threadId: granted.threadId,
      prompt: "keep using the same host",
    });
    const stickyClaim = await claimChatRun(runnerGroup, sticky.runId);
    await cu.heartbeatComputerUseHost(hostToken);
    await cu.requestCreateComputerUseWriteCommand(
      { bearer: zeroTokenFromClaim(stickyClaim.claim) },
      [200],
    );
    await cancelChatRun(actor, sticky.runId);

    // An explicit null clears the sticky host: the next run on the same
    // thread is no longer granted.
    const cleared = await sendChatRun(actor, {
      agentId,
      threadId: granted.threadId,
      prompt: "drop the host",
      computerUseHostId: null,
    });
    const clearedClaim = await claimChatRun(runnerGroup, cleared.runId);
    await cu.heartbeatComputerUseHost(hostToken);
    await cu.requestCreateComputerUseWriteCommand(
      { bearer: zeroTokenFromClaim(clearedClaim.claim) },
      [403],
    );
    await cancelChatRun(actor, cleared.runId);
  }, 120_000);

  it("rejects unusable computer-use host selections", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "Computer-use guard agent",
    });

    // Feature disabled: explicit selections are rejected outright.
    const featureDisabled = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        prompt: "use a host without the feature",
        computerUseHostId: randomUUID(),
      },
      [403],
    );
    expectApiError(featureDisabled.body);
    expect(featureDisabled.body.error.message).toBe(
      "Computer use is not enabled",
    );

    await cu.enableComputerUse(actor);
    const unknownHost = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        prompt: "use an unknown host",
        computerUseHostId: randomUUID(),
      },
      [404],
    );
    expectApiError(unknownHost.body);
    expect(unknownHost.body.error.message).toBe("Computer-use host not found");

    // Stopping a host revokes it, so an explicit selection reports it as
    // missing rather than offline.
    const stopped = await cu.startComputerUseHost(actor);
    await cu.stopComputerUseHost(stopped.hostToken);
    const revokedHost = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        prompt: "use a stopped host",
        computerUseHostId: stopped.hostId,
      },
      [404],
    );
    expectApiError(revokedHost.body);
    expect(revokedHost.body.error.message).toBe("Computer-use host not found");

    // A deleted sticky host is cleared on the next send without the field.
    // (The actor has no credits, so sends stop at admission — host selection
    // and sticky-host updates still happen first.)
    const sticky = await cu.startComputerUseHost(actor);
    const pinned = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        prompt: "pin the host before deleting it",
        computerUseHostId: sticky.hostId,
      },
      [201],
    );
    if (pinned.status !== 201) {
      throw new Error("Expected the pinned send to be accepted");
    }
    expect(pinned.body.runId).toBeNull();
    await cu.deleteComputerUseHost(actor, sticky.hostId);
    const clearedSend = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        threadId: pinned.body.threadId,
        prompt: "send after the host vanished",
      },
      [201],
    );
    expect(clearedSend.body).toMatchObject({ threadId: pinned.body.threadId });

    // Disabling the feature keeps non-explicit sends working without a grant.
    const survivor = await cu.startComputerUseHost(actor);
    const survivorThread = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        prompt: "pin a host before the feature is disabled",
        computerUseHostId: survivor.hostId,
      },
      [201],
    );
    if (survivorThread.status !== 201) {
      throw new Error("Expected the survivor send to be accepted");
    }
    await disableComputerUse(actor);
    const disabledStickySend = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        threadId: survivorThread.body.threadId,
        prompt: "send with the feature disabled",
      },
      [201],
    );
    expect(disabledStickySend.body).toMatchObject({
      threadId: survivorThread.body.threadId,
    });
    await cu.enableComputerUse(actor);

    // A host that stopped heartbeating goes stale-offline (status still
    // online, not revoked), which is the explicit-selection conflict arm.
    // Only one host can be online per user, so the surviving host is aged
    // past the heartbeat window instead of starting another one.
    mockNow(now() + 91_000);
    const offlineHost = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        prompt: "use a stale host",
        computerUseHostId: survivor.hostId,
      },
      [409],
    );
    expectApiError(offlineHost.body);
    expect(offlineHost.body.error.message).toBe(
      "Selected computer-use host is offline",
    );

    // The sticky-host fallthrough tolerates a stale host instead of failing:
    // a send without the field on the pinned thread is still accepted.
    const staleStickySend = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        threadId: survivorThread.body.threadId,
        prompt: "send while the sticky host is stale",
      },
      [201],
    );
    clearMockNow();
    expect(staleStickySend.body).toMatchObject({
      threadId: survivorThread.body.threadId,
    });
  }, 90_000);
});
