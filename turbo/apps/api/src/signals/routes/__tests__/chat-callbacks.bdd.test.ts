import { createHash, randomUUID } from "node:crypto";

import { WebPushError } from "web-push";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import type {
  AttachFile,
  GenerationTemplateRequest,
  ChatEventResponse,
  UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroGoalsContract } from "@vm0/api-contracts/contracts/zero-goals";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
} from "@vm0/core";
import { describe, expect, it, onTestFinished } from "vitest";

import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { accept, setupApp } from "../../../__tests__/test-helpers";
import {
  appendAutomationPauseFixture,
  readGoalQueueStateFixture,
} from "../../../test-fixtures/goal-queue";
import { testContext } from "../../../__tests__/test-context";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { now } from "../../external/time";
import { createDeferredPromise } from "../../utils";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { chatEventDisplayText } from "./helpers/chat-event";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import {
  generateDataKeyOutput,
  useSecretKmsProbe,
} from "./helpers/secret-kms-probe";

/**
 * CHAT-02 / HOOK-01: signed chat run callbacks through real dispatch.
 *
 * Terminal callbacks in this file originate from the real internal dispatcher
 * (sandbox complete/cancel webhooks and the sandbox heartbeat route), so normal
 * app-internal dispatch does not depend on an HTTP self-call.
 */

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const webhooks = createWebhookCallbackApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const misc = createMiscRoutesApi(context);

function goalsClient() {
  return setupApp({ context })(zeroGoalsContract);
}

const USER_ARTIFACTS_BUCKET = "test-user-artifacts";
const CHAT_CALLBACK_PRE_CREATE_TIMING_PREFIX =
  "api_dispatch_pre_create_zero_chat_callback_";
const GOAL_CAPABILITIES = [
  "goal:read",
  "goal:agent-result:write",
  "goal:user-control:write",
] as const satisfies readonly ZeroCapability[];
const FORBIDDEN_CHAT_CALLBACK_PRE_CREATE_TIMING_KEYS = [
  "org_id",
  "orgId",
  "user_id",
  "userId",
  "agent_id",
  "agentId",
  "thread_id",
  "threadId",
  "chat_thread_id",
  "chatThreadId",
  "message_id",
  "messageId",
  "user_message_id",
  "userMessageId",
  "file_id",
  "fileId",
  "model_id",
  "modelId",
  "model",
  "embedding_model",
  "embeddingModel",
  "embedding",
  "goal_id",
  "goalId",
  "query",
  "query_hash",
  "queryHash",
  "objective",
  "objective_brief",
  "objectiveBrief",
  "prompt",
  "vars",
  "secrets",
  "secret_names",
  "environment",
  "execution_context",
  "url",
  "presigned_url",
  "presignedUrl",
  "archive_url",
  "archiveUrl",
] as const;

type UserMessage = Extract<
  ChatEventResponse,
  {
    eventType:
      | "input.prompt"
      | "input.automation"
      | "input.rejected"
      | "control.interrupt"
      | "control.revoke";
  }
>;
type AssistantMessage = Exclude<ChatEventResponse, UserMessage>;
type PromptMessage = Extract<ChatEventResponse, { eventType: "input.prompt" }>;
type OutputMessage = Extract<
  ChatEventResponse,
  { eventType: "output.message" }
>;
type LifecycleEvent = "completed" | "failed" | "cancelled";
type LifecycleMessage<Event extends LifecycleEvent> = Extract<
  ChatEventResponse,
  { eventType: `run.${Event}` }
>;
type FollowupsMessage = Extract<
  ChatEventResponse,
  { eventType: "output.followups" }
>;
type TestOrgRole = "admin" | "member";

interface EntitledChatActor {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly providerId: string;
  readonly storage: {
    addObject(object: {
      readonly bucket: string;
      readonly key: string;
      readonly size: number;
    }): void;
  };
}

async function entitledChatActor(): Promise<EntitledChatActor> {
  const actor = bdd.user();
  const storage = chatCallbacks.acceptChatObjectStorage();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  chatCallbacks.disableVapid();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  const { providerId } = await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "BDD chat callback agent",
    description: "Exercises chat callback terminal processing.",
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, runnerGroup, providerId, storage };
}

async function entitledChatMemberActor(): Promise<EntitledChatActor> {
  const adminFixture = await entitledChatActor();
  if (!adminFixture.actor.orgId) {
    throw new Error("Expected the admin fixture to be org-scoped");
  }
  const actor = bdd.user({
    orgId: adminFixture.actor.orgId,
    orgRole: "org:member",
  });
  const agent = await bdd.createAgent(actor, {
    displayName: "BDD member chat callback agent",
    description: "Exercises member-owned chat callback terminal processing.",
    visibility: "private",
  });
  return { ...adminFixture, actor, agentId: agent.agentId };
}

async function startChatRun(
  actor: ApiTestUser,
  body: {
    readonly agentId: string;
    readonly prompt: string;
    readonly clientEventId?: string;
    readonly threadId?: string;
    readonly selectedModel?: string;
    readonly attachFiles?: readonly AttachFile[];
    readonly generationTemplate?: GenerationTemplateRequest;
    readonly userMessage?: UserMessageDocument;
    readonly revokesEventId?: string;
  },
): Promise<{
  readonly runId: string;
  readonly threadId: string;
  readonly messageId: string;
}> {
  const messageId = body.clientEventId ?? randomUUID();
  const requestBody = {
    agentId: body.agentId,
    prompt: body.prompt,
    clientEventId: messageId,
    ...(body.threadId === undefined ? {} : { threadId: body.threadId }),
    ...(body.attachFiles === undefined
      ? {}
      : { attachFiles: body.attachFiles }),
    ...(body.generationTemplate === undefined
      ? {}
      : { generationTemplate: body.generationTemplate }),
    ...(body.userMessage === undefined
      ? {}
      : { userMessage: body.userMessage }),
    ...(body.revokesEventId === undefined
      ? {}
      : { revokesEventId: body.revokesEventId }),
    ...(body.selectedModel === undefined
      ? body.threadId === undefined
        ? { model: "claude-sonnet-4-6" }
        : {}
      : { model: body.selectedModel }),
  };
  const sent = await chat.requestSendEvent(actor, requestBody, [201]);
  if (sent.status !== 201) {
    throw new Error("Expected the entitled chat send to create a run");
  }
  let runId: string | null | undefined = sent.body.runId;
  if (runId === null) {
    // A terminal callback may claim the queued row between enqueue and the
    // inline dispatch decision. Recover as a refreshed client does: read the
    // appended replacement instead of retrying the client message id.
    const messages = await waitForThreadMessages(
      actor,
      sent.body.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === messageId && message.runId !== undefined
          );
        });
      },
    );
    runId = userMessages(messages.events).find((message) => {
      return message.revokesEventId === messageId;
    })?.runId;
  }
  if (runId === undefined || runId === null) {
    throw new Error("Expected the entitled chat send to create a run");
  }
  return {
    runId,
    threadId: sent.body.threadId,
    messageId,
  };
}

async function queueChatMessage(
  actor: ApiTestUser,
  body: {
    readonly agentId: string;
    readonly threadId: string;
    readonly prompt: string;
    readonly attachFiles?: readonly AttachFile[];
    readonly generationTemplate?: GenerationTemplateRequest;
  },
): Promise<void> {
  const sent = await chat.requestSendEvent(
    actor,
    {
      agentId: body.agentId,
      threadId: body.threadId,
      prompt: body.prompt,
      ...(body.attachFiles === undefined
        ? {}
        : { attachFiles: body.attachFiles }),
      ...(body.generationTemplate === undefined
        ? {}
        : { generationTemplate: body.generationTemplate }),
    },
    [201],
  );
  if (sent.status !== 201 || sent.body.runId !== null) {
    throw new Error("Expected the chat send to queue while a run is active");
  }
}

function zeroGoalHeaders(
  actor: ApiTestUser,
  runId: string,
): { readonly authorization: string } {
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor for goal auth");
  }
  const seconds = Math.floor(now() / 1000);
  return {
    authorization: `Bearer ${signSandboxJwtForTests({
      scope: "zero",
      userId: actor.userId,
      orgId: actor.orgId,
      runId,
      capabilities: [...GOAL_CAPABILITIES],
      iat: seconds,
      exp: seconds + 600,
    })}`,
  };
}

async function enableGoalWorkflows(actor: ApiTestUser): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor for goal workflows");
  }
  await updateFeatureSwitchesForUser(
    context,
    {
      userId: actor.userId,
      orgId: actor.orgId,
      orgRole: actor.orgRole,
    },
    {},
  );
}

async function createGoalForRun(
  actor: ApiTestUser,
  runId: string,
  objective: string,
): Promise<void> {
  await accept(
    goalsClient().create({
      headers: zeroGoalHeaders(actor, runId),
      body: { objective },
    }),
    [201],
  );
}

async function claimChatRunJob(runnerGroup: string, runId: string) {
  await api.heartbeatRunner(runnerGroup);
  let claim: Awaited<ReturnType<typeof api.requestClaimRunnerJob>> | undefined;
  await expect
    .poll(
      async () => {
        claim = await api.requestClaimRunnerJob(true, runId, [200, 404]);
        return claim.status;
      },
      { interval: 100, timeout: 10_000 },
    )
    .toBe(200);
  if (!claim || claim.status !== 200) {
    throw new Error("Expected the chat run to be claimable");
  }
  return claim.body;
}

async function claimChatRun(
  runnerGroup: string,
  runId: string,
): Promise<{ readonly authorization: string }> {
  const claim = await claimChatRunJob(runnerGroup, runId);
  return { authorization: `Bearer ${claim.sandboxToken}` };
}

function cliAgentSessionIdForChatRun(runId: string): string {
  return `bdd-cli-${runId}`;
}

async function waitForThreadMessages(
  actor: ApiTestUser,
  threadId: string,
  predicate: (messages: readonly ChatEventResponse[]) => boolean,
) {
  let page: Awaited<ReturnType<typeof chat.listThreadEvents>> | undefined;
  await expect
    .poll(
      async () => {
        page = await chat.listThreadEvents(actor, threadId);
        return predicate(page.events);
      },
      { interval: 100, timeout: 10_000 },
    )
    .toBe(true);
  if (!page) {
    throw new Error(`Expected chat thread ${threadId} messages to be readable`);
  }
  return page;
}

async function waitForThreadTitle(
  actor: ApiTestUser,
  threadId: string,
  title: string | null,
): Promise<void> {
  await expect
    .poll(async () => {
      return await readThreadTitleFromEvents(actor, threadId);
    })
    .toBe(title);
}

async function readThreadTitleFromEvents(
  actor: ApiTestUser,
  threadId: string,
): Promise<string | null> {
  const events = await chat.requestThreadEvents(actor, {}, [200]);
  if (events.status !== 200) {
    throw new Error("Expected chat thread events to load");
  }

  let latestTitleEvent:
    | { readonly title: string | null; readonly createdAt: string }
    | undefined;
  for (const event of events.body.events) {
    if (
      event.chatThreadId !== threadId ||
      (event.kind !== "created" && event.kind !== "renamed")
    ) {
      continue;
    }
    if (
      latestTitleEvent === undefined ||
      Date.parse(event.createdAt) >= Date.parse(latestTitleEvent.createdAt)
    ) {
      latestTitleEvent = event;
    }
  }

  return latestTitleEvent?.title ?? null;
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

async function waitForRunContext(actor: ApiTestUser, runId: string) {
  let response: Awaited<ReturnType<typeof api.requestRunContext>> | undefined;
  await expect
    .poll(async () => {
      response = await api.requestRunContext(actor, runId, [200, 404]);
      return response.status;
    })
    .toBe(200);
  if (!response || response.status !== 200) {
    throw new Error("Expected the auto-send run context to be readable");
  }
  return response;
}

async function goalQueueEventIds(threadId: string): Promise<readonly string[]> {
  return (await readGoalQueueStateFixture(threadId)).eventIds;
}

async function goalRunIds(threadId: string): Promise<readonly string[]> {
  return (await readGoalQueueStateFixture(threadId)).runIds;
}

/**
 * Checkpoint + exitCode-0 complete. Completing without a checkpoint routes to
 * the missing-checkpoint handler and FAILS the run, so every successful chat
 * round checkpoints first.
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
      cliAgentSessionId: cliAgentSessionIdForChatRun(runId),
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

function assistantMessages(
  messages: readonly ChatEventResponse[],
): AssistantMessage[] {
  return messages.filter((message): message is AssistantMessage => {
    return !isUserMessage(message);
  });
}

function userMessages(messages: readonly ChatEventResponse[]): UserMessage[] {
  return messages.filter(isUserMessage);
}

function isUserMessage(message: ChatEventResponse): message is UserMessage {
  switch (message.eventType) {
    case "input.prompt":
    case "input.automation":
    case "input.rejected":
    case "control.interrupt":
    case "control.revoke": {
      return true;
    }
    default: {
      return false;
    }
  }
}

function isGoalContinuationUserMessage(
  message: UserMessage,
  objectiveBrief: string,
): boolean {
  return (
    message.isGoalRun === true &&
    message.runId !== undefined &&
    (message.goalSnapshot?.objectiveBrief === objectiveBrief ||
      chatEventDisplayText(message)?.includes("# Active thread goal") === true)
  );
}

function eventBackedContents(
  messages: readonly ChatEventResponse[],
  runId: string,
): OutputMessage[] {
  return messages.filter((message): message is OutputMessage => {
    return message.eventType === "output.message" && message.runId === runId;
  });
}

function lifecycleMarkers<Event extends LifecycleEvent>(
  messages: readonly ChatEventResponse[],
  runId: string,
  event: Event,
): LifecycleMessage<Event>[] {
  return messages.filter((message): message is LifecycleMessage<Event> => {
    return message.runId === runId && message.eventType === `run.${event}`;
  });
}

function recommendedFollowupMessages(
  messages: readonly ChatEventResponse[],
  runId: string,
): FollowupsMessage[] {
  return messages.filter((message): message is FollowupsMessage => {
    return (
      message.eventType === "output.followups" &&
      message.runId === runId &&
      message.recommendedFollowups.length > 0
    );
  });
}

async function waitForChatThreadMessageCreatedPublish(
  threadId: string,
): Promise<void> {
  await expect
    .poll(() => {
      return context.mocks.ably.publish.mock.calls.some((call) => {
        return call[0] === `chatThreadMessageCreated:${threadId}`;
      });
    })
    .toBe(true);
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

function resultEvent(
  sequenceNumber: number,
  result: string,
): Record<string, unknown> {
  return { eventType: "result", sequenceNumber, eventData: { result } };
}

function chatOutputAxiomQueryCalls(): readonly unknown[][] {
  return context.mocks.axiom.query.mock.calls.filter((call) => {
    const apl = call[0];
    return (
      typeof apl === "string" &&
      apl.includes("['agent-run-events']") &&
      apl.includes('eventType == "assistant"')
    );
  });
}

function pushPayload(call: readonly unknown[] | undefined): unknown {
  const raw = call?.[1];
  return JSON.parse(typeof raw === "string" ? raw : "{}");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sandboxOperationEventsForRun(
  runId: string,
): readonly Record<string, unknown>[] {
  return context.mocks.axiom.sdkIngest.mock.calls.flatMap((call) => {
    const dataset = call[0];
    const events = call[1];
    if (dataset !== "vm0-sandbox-op-log-dev" || !Array.isArray(events)) {
      return [];
    }
    return events.filter((event): event is Record<string, unknown> => {
      return isRecord(event) && event.run_id === runId;
    });
  });
}

function firstAssistantMessageEventsForRun(
  runId: string,
): readonly Record<string, unknown>[] {
  return sandboxOperationEventsForRun(runId).filter((event) => {
    return event.op_type === "api_to_first_assistant_message";
  });
}

function chatCallbackPreCreateTimingEventsForRun(
  runId: string,
): readonly Record<string, unknown>[] {
  return sandboxOperationEventsForRun(runId).filter((event) => {
    return (
      typeof event.op_type === "string" &&
      event.op_type.startsWith(CHAT_CALLBACK_PRE_CREATE_TIMING_PREFIX)
    );
  });
}

function expectNoForbiddenChatCallbackPreCreateTimingKeys(
  events: readonly Record<string, unknown>[],
): void {
  for (const event of events) {
    for (const key of FORBIDDEN_CHAT_CALLBACK_PRE_CREATE_TIMING_KEYS) {
      expect(event).not.toHaveProperty(key);
    }
  }
}

async function expectChatCallbackPreCreateTimingActions(
  runId: string,
  expectedActionTypes: readonly string[],
): Promise<readonly Record<string, unknown>[]> {
  await expect
    .poll(() => {
      const observed = new Set(
        chatCallbackPreCreateTimingEventsForRun(runId).map((event) => {
          return event.op_type;
        }),
      );
      return expectedActionTypes.filter((actionType) => {
        return !observed.has(actionType);
      });
    })
    .toStrictEqual([]);
  const events = chatCallbackPreCreateTimingEventsForRun(runId);
  expectNoForbiddenChatCallbackPreCreateTimingKeys(events);
  return events;
}

function expectNoChatCallbackPreCreateTimingActions(
  events: readonly Record<string, unknown>[],
  unexpectedActionTypes: readonly string[],
): void {
  const observed = new Set(
    events.map((event) => {
      return event.op_type;
    }),
  );
  for (const actionType of unexpectedActionTypes) {
    expect(observed).not.toContain(actionType);
  }
}

async function expectZeroPreCreateSource(
  runId: string,
  source: string,
): Promise<void> {
  await expect
    .poll(() => {
      return sandboxOperationEventsForRun(runId);
    })
    .toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op_type: "api_dispatch_pre_create_agent_run",
          zero_pre_create_source: source,
        }),
      ]),
    );
}

function deferredGate(): {
  readonly wait: () => Promise<void>;
  readonly release: () => void;
} {
  const gate = createDeferredPromise<void>(context.signal);
  const releaseGate = (): void => {
    if (!gate.settled()) {
      gate.resolve(undefined);
    }
  };
  onTestFinished(() => {
    releaseGate();
  });
  return {
    wait: () => {
      return gate.promise;
    },
    release: releaseGate,
  };
}

describe("CHAT-02: completed chat callback", () => {
  it("persists assistant output, reorders threads, titles the thread, recommends follow-ups, notifies, and auto-sends the queued template message", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const titlePrompts: string[] = [];
    const followupSystemPrompts: string[] = [];
    const followupPrompts: string[] = [];
    const longFollowupPrompt =
      "Can you draft a new 90-minute workshop outline that focuses on the event-driven workflow of an AI Lead Operations Team and includes hands-on exercises?";
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    chatCallbacks.mockOpenRouterCompletions((body) => {
      const systemContent = body.messages[0]?.content ?? "";
      if (systemContent.includes("Generate a short, descriptive title")) {
        titlePrompts.push(body.messages[1]?.content ?? "");
        return "Debugging Node Apps";
      }
      if (systemContent.includes("concise follow-up prompts")) {
        followupSystemPrompts.push(systemContent);
        followupPrompts.push(body.messages[1]?.content ?? "");
        return JSON.stringify([
          { prompt: longFollowupPrompt, kind: "talk" },
          {
            prompt: "Generate a landing page for this plan",
            kind: "generate",
            generationType: "website",
          },
        ]);
      }
      return "Generated summary";
    });

    const prompt = "How do I debug my Node app?";
    const first = await startChatRun(actor, {
      agentId,
      prompt,
      selectedModel: "claude-sonnet-4-6",
    });

    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
    if (!template) {
      throw new Error("Expected a registered presentation runbook item");
    }
    const generationTemplate: GenerationTemplateRequest = {
      type: "presentation",
      selection: {
        templateId: template.templateId,
      },
    };
    await queueChatMessage(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "queued next turn",
      generationTemplate,
    });
    const beforeComplete = await chat.listThreadEvents(actor, first.threadId);
    const queued = userMessages(beforeComplete.events).find((message) => {
      return chatEventDisplayText(message) === "queued next turn";
    });
    if (!queued) {
      throw new Error("Expected the queued user message to be listed");
    }

    // Sentinel thread with a later lastMessageAt than thread X, so the
    // run-end bump on X is observable through thread-list reordering.
    const sentinel = await startChatRun(actor, {
      agentId,
      prompt: "unrelated sentinel run",
    });
    await api.requestCancelRun(actor, sentinel.runId, [200]);
    await waitForRunStatus(actor, sentinel.runId, "cancelled");
    await waitForThreadTitle(actor, first.threadId, "Debugging Node Apps");
    const titlePromptCountBeforeComplete = titlePrompts.length;

    await chatCallbacks.registerPushSubscription(actor);
    chatCallbacks.enableVapid();

    const sandboxHeaders = await claimChatRun(runnerGroup, first.runId);
    context.mocks.ably.publish.mockClear();
    chatCallbacks.mockChatOutputEvents([assistantEvent(0, "final answer")]);
    await completeChatRunOk(first.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });

    const after = await waitForThreadMessages(
      actor,
      first.threadId,
      (messages) => {
        return (
          eventBackedContents(messages, first.runId).length === 1 &&
          recommendedFollowupMessages(messages, first.runId).some((message) => {
            return (message.recommendedFollowups?.length ?? 0) === 2;
          })
        );
      },
    );
    expect(
      eventBackedContents(after.events, first.runId).map((message) => {
        return message.content;
      }),
    ).toStrictEqual(["final answer"]);
    expect(
      eventBackedContents(after.events, first.runId)[0],
    ).not.toHaveProperty("status");

    const marker = lifecycleMarkers(after.events, first.runId, "completed")[0];
    if (!marker) {
      throw new Error("Expected a completed lifecycle marker");
    }
    expect(marker.content).toBeNull();
    expect(marker).not.toHaveProperty("status");
    expect(marker).not.toHaveProperty("recommendedFollowups");
    const recommender = recommendedFollowupMessages(
      after.events,
      first.runId,
    )[0];
    if (!recommender) {
      throw new Error("Expected a recommended follow-up message");
    }
    expect(recommender.recommendedFollowups).toStrictEqual([
      { prompt: longFollowupPrompt, kind: "talk" },
      {
        prompt: "Generate a landing page for this plan",
        kind: "generate",
        generationType: "website",
      },
    ]);
    expect(followupPrompts).toHaveLength(1);
    expect(followupPrompts[0]).toContain("final answer");
    expect(followupPrompts[0]).not.toContain("queued next turn");
    expect(followupSystemPrompts).toStrictEqual([
      expect.stringContaining(
        'The "prompt" values are shown as plain text, not rendered as Markdown',
      ),
    ]);

    await waitForThreadTitle(actor, first.threadId, "Debugging Node Apps");
    expect(titlePrompts).toHaveLength(titlePromptCountBeforeComplete);
    const initialTitlePrompt = titlePrompts.find((titlePrompt) => {
      return titlePrompt.includes(`Most recent user message:\n${prompt}`);
    });
    if (initialTitlePrompt === undefined) {
      throw new Error("Expected the initial send to request a thread title");
    }
    expect(initialTitlePrompt).not.toContain(
      "Most recent assistant reply:\nfinal answer",
    );

    const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
    expect(threadEvents.status).toBe(200);
    if (threadEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    const relevantEvents = threadEvents.body.events.filter((event) => {
      return (
        event.chatThreadId === first.threadId ||
        event.chatThreadId === sentinel.threadId
      );
    });
    expect(relevantEvents.at(-1)).toMatchObject({
      kind: "sort_touched",
      chatThreadId: first.threadId,
    });

    await expect
      .poll(() => {
        return context.mocks.webpush.sendNotification.mock.calls.some(
          (call) => {
            const payload = pushPayload(call) as Record<string, unknown>;
            return (
              payload.title === prompt.slice(0, 60) &&
              payload.body === "Generated summary" &&
              payload.url === `/chats/${first.threadId}`
            );
          },
        );
      })
      .toBe(true);

    const afterAutoSend = await waitForThreadMessages(
      actor,
      first.threadId,
      (messages) => {
        return userMessages(messages).some((message) => {
          return (
            chatEventDisplayText(message) === "queued next turn" &&
            message.runId !== undefined
          );
        });
      },
    );
    const claimed = userMessages(afterAutoSend.events).find(
      (message): message is PromptMessage => {
        return (
          message.eventType === "input.prompt" &&
          chatEventDisplayText(message) === "queued next turn" &&
          message.runId !== undefined
        );
      },
    );
    if (!claimed?.runId) {
      throw new Error("Expected the queued message to be auto-claimed");
    }
    expect(claimed.runId).not.toBe(first.runId);
    expect(claimed.id).not.toBe(queued.id);
    expect(claimed.revokesEventId).toBe(queued.id);
    expect(claimed.generationTemplate).toStrictEqual(generationTemplate);
    const original = await chat.getThreadEvent(
      actor,
      first.threadId,
      queued.id,
    );
    expect(original.runId).toBeUndefined();
    // The raw message page contains both immutable rows; the client folds the
    // original into its run-associated replacement.
    const matchingMessageIds = userMessages(afterAutoSend.events)
      .filter((message) => {
        return chatEventDisplayText(message) === "queued next turn";
      })
      .map((message) => {
        return message.id;
      });
    expect(matchingMessageIds).toHaveLength(2);
    expect(matchingMessageIds).toStrictEqual(
      expect.arrayContaining([queued.id, claimed.id]),
    );
    // The auto-send publishes happen in background callback processing, so
    // poll until each expected channel has been published before asserting.
    await expect
      .poll(() => {
        return context.mocks.ably.publish.mock.calls.some((call) => {
          return call[0] === `chatThreadMessageCreated:${first.threadId}`;
        });
      })
      .toBe(true);
    await expect
      .poll(() => {
        return context.mocks.ably.publish.mock.calls.some((call) => {
          return call[0] === `chatThreadRunCreated:${first.threadId}`;
        });
      })
      .toBe(true);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadMessageCreated:${first.threadId}`,
      null,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadRunCreated:${first.threadId}`,
      null,
    );

    const autoContext = await waitForRunContext(actor, claimed.runId);
    expect(autoContext.body.prompt).toBe("queued next turn");
    const appended = autoContext.body.appendSystemPrompt ?? "";
    expect(appended).toContain(
      "# Current Integration\nYou are currently running inside: Web",
    );
    expect(appended).toContain("# Artifact Template Context");
    expect(appended).toContain(
      "Selected presentation template: Playful Launch Presentation (template:html-ppt-playful-launch)",
    );
    expect(appended).not.toContain("Selected design system");
    // Runbook flow, not the retired multi-resource flow.
    expect(appended).toContain(
      `zero resource pull ${template.templateId}-runbook --dir ./generated/resources`,
    );
    expect(appended).toContain("--artifact-kind presentation-html");
    expect(appended).not.toContain(
      "zero generate presentation --design-system",
    );
    expect(Object.keys(autoContext.body.environment)).toContain(
      "ANTHROPIC_API_KEY",
    );

    await api.requestCancelRun(actor, claimed.runId, [200]);
    await waitForRunStatus(actor, claimed.runId, "cancelled");
  }, 90_000);

  it("uses the dequeue API start when a queued message auto-sends", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await startChatRun(actor, {
      agentId,
      prompt: "hold the thread while the next message queues",
    });
    const firstHeaders = await claimChatRun(runnerGroup, first.runId);
    const queuedAt = now() + 60_000;
    const dequeuedAt = queuedAt + 1000;
    const queuedPrompt = "measure from queued message dequeue";
    mockNow(queuedAt);
    onTestFinished(() => {
      clearMockNow();
    });

    await queueChatMessage(actor, {
      agentId,
      threadId: first.threadId,
      prompt: queuedPrompt,
    });

    mockNow(dequeuedAt);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "finish the blocking run"),
    ]);
    await completeChatRunOk(first.runId, firstHeaders, {
      lastEventSequence: 0,
    });

    const afterAutoSend = await waitForThreadMessages(
      actor,
      first.threadId,
      (messages) => {
        return userMessages(messages).some((message) => {
          return (
            chatEventDisplayText(message) === queuedPrompt &&
            message.runId !== undefined
          );
        });
      },
    );
    const claimed = userMessages(afterAutoSend.events).find((message) => {
      return (
        chatEventDisplayText(message) === queuedPrompt &&
        message.runId !== undefined
      );
    });
    if (!claimed?.runId) {
      throw new Error("Expected the queued Web message to auto-send");
    }

    const acknowledgedAt = dequeuedAt + 7000;
    const secondClaim = await claimChatRunJob(runnerGroup, claimed.runId);
    expect(secondClaim.apiStartTime).toBe(dequeuedAt);
    const secondHeaders = {
      authorization: `Bearer ${secondClaim.sandboxToken}`,
    };
    await flushWaitUntilForTest();
    context.mocks.ably.publish.mockClear();
    mockNow(acknowledgedAt);
    await webhooks.requestAgentEvents(
      {
        runId: claimed.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: {
              id: "msg_bdd_queued_first_output",
              content: [{ type: "text", text: "Queued run real output" }],
            },
          },
        ],
      },
      secondHeaders,
      [200],
    );
    await flushWaitUntilForTest();

    expect(firstAssistantMessageEventsForRun(claimed.runId)).toStrictEqual([
      expect.objectContaining({
        _time: new Date(acknowledgedAt).toISOString(),
        duration_ms: acknowledgedAt - dequeuedAt,
        run_id: claimed.runId,
      }),
    ]);

    await api.requestCancelRun(actor, claimed.runId, [200]);
    await waitForRunStatus(actor, claimed.runId, "cancelled");
  }, 90_000);

  it("uses userMessage semantics for title and recommended follow-up context", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const style = ILLUSTRATION_TEMPLATE_ITEMS[0];
    if (!style) {
      throw new Error("Expected a registered illustration style");
    }
    const generationTemplate: GenerationTemplateRequest = {
      type: "illustration",
      selection: { illustrationStyleId: style.illustrationStyleId },
    };
    const firstUserMessage: UserMessageDocument = {
      version: 1,
      parts: [
        {
          type: "template",
          titleSnapshot: style.title,
          template: generationTemplate,
        },
        { type: "text", text: "first structured request" },
      ],
    };
    const templatePrompt = `Select ${style.title} illustration template`;

    const first = await startChatRun(actor, {
      agentId,
      prompt: "stale first legacy request",
      generationTemplate,
      userMessage: firstUserMessage,
    });
    const firstHeaders = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "first structured answer"),
    ]);
    await completeChatRunOk(first.runId, firstHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();

    const titlePrompts: string[] = [];
    const followupPrompts: string[] = [];
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    chatCallbacks.mockOpenRouterCompletions((body) => {
      const systemContent = body.messages[0]?.content ?? "";
      if (systemContent.includes("Generate a short, descriptive title")) {
        titlePrompts.push(body.messages[1]?.content ?? "");
        return "Structured Context";
      }
      if (systemContent.includes("concise follow-up prompts")) {
        followupPrompts.push(body.messages[1]?.content ?? "");
        return JSON.stringify([
          { prompt: "Continue the structured work", kind: "talk" },
        ]);
      }
      return "Generated summary";
    });

    const second = await startChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "stale second legacy request",
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: "second structured request" }],
      },
    });
    await waitForThreadTitle(actor, first.threadId, "Structured Context");

    const userMessageContext = [
      templatePrompt,
      "first structured request",
      "second structured request",
    ];
    const legacyContext = [
      "stale first legacy request",
      "stale second legacy request",
    ];
    const expectedContext = userMessageContext;
    const excludedContext = legacyContext;

    expect(titlePrompts).toHaveLength(1);
    for (const value of expectedContext) {
      expect(titlePrompts[0]).toContain(value);
    }
    for (const value of excludedContext) {
      expect(titlePrompts[0]).not.toContain(value);
    }

    const secondHeaders = await claimChatRun(runnerGroup, second.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "second structured answer"),
    ]);
    await completeChatRunOk(second.runId, secondHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();

    expect(followupPrompts).toHaveLength(1);
    for (const value of expectedContext) {
      expect(followupPrompts[0]).toContain(value);
    }
    expect(followupPrompts[0]).toContain("second structured answer");
    for (const value of excludedContext) {
      expect(followupPrompts[0]).not.toContain(value);
    }
  }, 90_000);

  it("suppresses malformed recommended follow-up JSON instead of storing raw syntax lines", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    let followupRequests = 0;
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    chatCallbacks.mockOpenRouterCompletions((body) => {
      const systemContent = body.messages[0]?.content ?? "";
      if (systemContent.includes("concise follow-up prompts")) {
        followupRequests += 1;
        return [
          "[",
          "{",
          '"prompt": "Investigate this malformed follow-up",',
          '"kind": "talk"',
        ].join("\n");
      }
      if (systemContent.includes("Generate a short, descriptive title")) {
        return "Malformed Follow-ups";
      }
      return "Generated summary";
    });

    const run = await startChatRun(actor, {
      agentId,
      prompt: "Explain how to debug malformed follow-ups",
    });
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "The final assistant answer"),
    ]);
    context.mocks.ably.publish.mockClear();
    await completeChatRunOk(run.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();

    expect(followupRequests).toBe(1);
    expect(sandboxOperationEventsForRun(run.runId)).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op_type: "last_event_to_complete",
          duration_ms: expect.any(Number),
          success: true,
        }),
      ]),
    );
    const after = await chat.listThreadEvents(actor, run.threadId);
    const marker = lifecycleMarkers(after.events, run.runId, "completed")[0];
    if (!marker) {
      throw new Error("Expected a completed lifecycle marker");
    }
    expect(marker).not.toHaveProperty("recommendedFollowups");
  });

  it("auto-sends the queued message before completed-run LLM side effects finish", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await startChatRun(actor, {
      agentId,
      prompt: "finish the current turn",
    });
    await queueChatMessage(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "queued while side effects wait",
    });

    const queuedBeforeComplete = await chat.listThreadEvents(
      actor,
      first.threadId,
    );
    const queued = userMessages(queuedBeforeComplete.events).find((message) => {
      return chatEventDisplayText(message) === "queued while side effects wait";
    });
    if (!queued) {
      throw new Error("Expected the queued user message to be listed");
    }

    const openRouterGate = deferredGate();
    const titlePrompts: string[] = [];
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    chatCallbacks.mockOpenRouterCompletions(async (body) => {
      await openRouterGate.wait();
      const systemContent = body.messages[0]?.content ?? "";
      if (systemContent.includes("concise follow-up prompts")) {
        return JSON.stringify([
          { prompt: "Review the queued result", kind: "talk" },
        ]);
      }
      if (systemContent.includes("Generate a short, descriptive title")) {
        titlePrompts.push(body.messages[1]?.content ?? "");
        return "Deferred Side Effects";
      }
      return "Deferred summary";
    });

    const sandboxHeaders = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([assistantEvent(0, "completed answer")]);
    await completeChatRunOk(first.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });

    const afterAutoSend = await waitForThreadMessages(
      actor,
      first.threadId,
      (messages) => {
        return userMessages(messages).some((message) => {
          return (
            message.revokesEventId === queued.id && message.runId !== undefined
          );
        });
      },
    );
    const markerBeforeRelease = lifecycleMarkers(
      afterAutoSend.events,
      first.runId,
      "completed",
    )[0];
    if (!markerBeforeRelease) {
      throw new Error(
        "Expected completed marker before releasing side effects",
      );
    }
    expect(markerBeforeRelease).not.toHaveProperty("recommendedFollowups");

    const claimed = userMessages(afterAutoSend.events).find((message) => {
      return message.revokesEventId === queued.id;
    });
    if (!claimed?.runId) {
      throw new Error("Expected the queued message to auto-send");
    }
    expect(claimed.runId).not.toBe(first.runId);
    await expectZeroPreCreateSource(claimed.runId, "chat_callback_auto_send");
    await expectChatCallbackPreCreateTimingActions(claimed.runId, [
      "api_dispatch_pre_create_zero_chat_callback_load_terminal",
      "api_dispatch_pre_create_zero_chat_callback_prepare_completed",
      "api_dispatch_pre_create_zero_chat_callback_load_db_output_state",
      "api_dispatch_pre_create_zero_chat_callback_db_output_incomplete",
      "api_dispatch_pre_create_zero_chat_callback_query_output_events",
      "api_dispatch_pre_create_zero_chat_callback_insert_assistant_items",
      "api_dispatch_pre_create_zero_chat_callback_insert_lifecycle_marker",
      "api_dispatch_pre_create_zero_chat_callback_load_followup_context",
      "api_dispatch_pre_create_zero_chat_callback_auto_send_load_thread",
      "api_dispatch_pre_create_zero_chat_callback_auto_send_lookup_queued_message",
      "api_dispatch_pre_create_zero_chat_callback_auto_send_build_input",
      "api_dispatch_pre_create_zero_chat_callback_auto_send_create_run",
      "api_dispatch_pre_create_zero_chat_callback_auto_send_publish_signals",
    ]);

    context.mocks.ably.publish.mockClear();
    openRouterGate.release();
    const afterFollowups = await waitForThreadMessages(
      actor,
      first.threadId,
      (messages) => {
        return recommendedFollowupMessages(messages, first.runId).some(
          (message) => {
            return (message.recommendedFollowups?.length ?? 0) === 1;
          },
        );
      },
    );
    expect(
      lifecycleMarkers(afterFollowups.events, first.runId, "completed"),
    ).toHaveLength(1);
    const markerAfterRelease = lifecycleMarkers(
      afterFollowups.events,
      first.runId,
      "completed",
    )[0];
    expect(markerAfterRelease?.id).toBe(markerBeforeRelease.id);
    expect(markerAfterRelease).not.toHaveProperty("recommendedFollowups");
    const followupMessage = recommendedFollowupMessages(
      afterFollowups.events,
      first.runId,
    )[0];
    if (!followupMessage) {
      throw new Error("Expected a recommended follow-up message");
    }
    expect(followupMessage.recommendedFollowups).toStrictEqual([
      { prompt: "Review the queued result", kind: "talk" },
    ]);
    await waitForChatThreadMessageCreatedPublish(first.threadId);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadMessageCreated:${first.threadId}`,
      { syncThroughSeqId: followupMessage.seqId },
    );
    expect(titlePrompts).toHaveLength(1);
    expect(titlePrompts[0]).toContain("finish the current turn");
    expect(titlePrompts[0]).not.toContain("queued while side effects wait");

    await flushWaitUntilForTest();

    await queueChatMessage(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "queued after duplicate callback",
    });
    const afterSecondQueue = await chat.listThreadEvents(actor, first.threadId);
    const duplicateProbeQueued = userMessages(afterSecondQueue.events).find(
      (message) => {
        return (
          chatEventDisplayText(message) === "queued after duplicate callback"
        );
      },
    );
    if (!duplicateProbeQueued) {
      throw new Error("Expected the duplicate probe message to queue");
    }

    await completeChatRunOk(first.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();

    const afterDuplicateCallback = await chat.listThreadEvents(
      actor,
      first.threadId,
    );
    const duplicateProbeClaimed = userMessages(
      afterDuplicateCallback.events,
    ).filter((message) => {
      return message.revokesEventId === duplicateProbeQueued.id;
    });
    expect(duplicateProbeClaimed).toHaveLength(0);
    const duplicateProbeStillQueued = userMessages(
      afterDuplicateCallback.events,
    ).find((message) => {
      return message.id === duplicateProbeQueued.id;
    });
    expect(duplicateProbeStillQueued?.runId).toBeUndefined();

    await api.requestCancelRun(actor, claimed.runId, [200]);
    await waitForRunStatus(actor, claimed.runId, "cancelled");
  }, 90_000);

  it("continues an active goal through automation pause with the full objective in the run prompt and the brief in the user message snapshot", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await enableGoalWorkflows(actor);
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await startChatRun(actor, {
      agentId,
      prompt: "finish before goal continuation",
    });
    const goalBrief = "Keep making autonomous progress";
    const noisySeparator = "!".repeat(1100);
    const goalObjective = `${goalBrief}

${noisySeparator}

Continue the JPM IJTXX Treasury allocation follow-up for issue #20818 and [ACME-42](https://acme.example.com/treasury) before marking done.`;
    await createGoalForRun(actor, first.runId, goalObjective);
    await appendAutomationPauseFixture({
      threadId: first.threadId,
      reason: "automation pause must not gate goal continuation",
    });

    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "completed before goal continuation"),
    ]);

    const sandboxHeaders = await claimChatRun(runnerGroup, first.runId);
    await completeChatRunOk(first.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });

    const messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return isGoalContinuationUserMessage(message, goalBrief);
        });
      },
    );
    const goalContinuation = userMessages(messages.events).find((message) => {
      return isGoalContinuationUserMessage(message, goalBrief);
    });
    expect(goalContinuation?.goalSnapshot).toStrictEqual({
      objectiveBrief: goalBrief,
    });
    expect(goalContinuation?.content).toBeNull();
    expect(chatEventDisplayText(goalContinuation!)).toContain(
      "# Active thread goal",
    );
    expect(chatEventDisplayText(goalContinuation!)).toContain(goalObjective);

    if (!goalContinuation?.runId) {
      throw new Error("Expected goal continuation run id");
    }
    const goalContext = await waitForRunContext(actor, goalContinuation.runId);
    expect(goalContext.body.prompt).toContain("# Active thread goal");
    expect(goalContext.body.prompt).toContain(goalObjective);
    expect(goalContext.body.appendSystemPrompt ?? "").not.toContain(
      "# Active thread goal",
    );
    expect(goalContext.body.appendSystemPrompt ?? "").not.toContain(
      "# How to operate",
    );
    expect(goalContext.body.sessionId).toBe(
      cliAgentSessionIdForChatRun(first.runId),
    );
    const continuationClaim = await claimChatRunJob(
      runnerGroup,
      goalContinuation.runId,
    );
    expect(continuationClaim.resumeSession?.sessionId).toBe(
      cliAgentSessionIdForChatRun(first.runId),
    );
    await api.requestCancelRun(actor, goalContinuation.runId, [200]);
    await waitForRunStatus(actor, goalContinuation.runId, "cancelled");
    await flushWaitUntilForTest();
  }, 90_000);

  it("rejects a goal invalidated during run preparation without creating a run", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await enableGoalWorkflows(actor);
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await startChatRun(actor, {
      agentId,
      prompt: "finish before post-claim goal invalidation",
    });
    const objectiveBrief = "invalidate after goal preparation";
    await createGoalForRun(actor, first.runId, objectiveBrief);
    const runPreparationStarted = createDeferredPromise<void>(context.signal);
    const releaseRunPreparation = deferredGate();
    useSecretKmsProbe((command) => {
      // The terminal callback drain and the goal enqueue drain may both prepare
      // this queued run. Hold every preparation so neither can win the final
      // claim before the goal is paused.
      if (!runPreparationStarted.settled()) {
        runPreparationStarted.resolve(undefined);
      }
      return releaseRunPreparation.wait().then(() => {
        return generateDataKeyOutput(command);
      });
    });
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "completed before post-claim goal invalidation"),
    ]);

    const sandboxHeaders = await claimChatRun(runnerGroup, first.runId);
    await completeChatRunOk(first.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });
    await runPreparationStarted.promise;

    const paused = await accept(
      goalsClient().pause({
        headers: zeroGoalHeaders(actor, first.runId),
      }),
      [200],
    );
    expect(paused.body.status).toBe("paused");
    const [goalEventId] = await goalQueueEventIds(first.threadId);
    expect(goalEventId).toBeDefined();
    releaseRunPreparation.release();

    const events = await waitForThreadMessages(
      actor,
      first.threadId,
      (items) => {
        return items.some((event) => {
          return (
            event.eventType === "input.rejected" &&
            event.revokesEventId === goalEventId
          );
        });
      },
    );
    expect(events.events).toContainEqual(
      expect.objectContaining({
        eventType: "input.rejected",
        revokesEventId: goalEventId,
        content: null,
        error: "Goal continuation no longer matches the active goal",
        goalSnapshot: { objectiveBrief },
      }),
    );
    const rejected = events.events.find((event) => {
      return (
        event.eventType === "input.rejected" &&
        event.revokesEventId === goalEventId
      );
    });
    if (rejected?.eventType !== "input.rejected") {
      throw new Error("Expected the invalidated goal event to be rejected");
    }
    expect(chatEventDisplayText(rejected)).toBe(objectiveBrief);
    await expect(goalRunIds(first.threadId)).resolves.toHaveLength(0);
  }, 90_000);

  it("pauses the goal and rejects its event when claim-time run creation fails", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await enableGoalWorkflows(actor);
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await startChatRun(actor, {
      agentId,
      prompt: "finish before goal claim fails",
    });
    await createGoalForRun(actor, first.runId, "pause after claim failure");
    await misc.deleteOrgModelProvider(actor, "anthropic-api-key", [204]);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "completed before goal claim failure"),
    ]);

    const sandboxHeaders = await claimChatRun(runnerGroup, first.runId);
    await completeChatRunOk(first.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });

    await expect
      .poll(async () => {
        const goal = await accept(
          goalsClient().get({
            headers: zeroGoalHeaders(actor, first.runId),
          }),
          [200],
        );
        return goal.body.status;
      })
      .toBe("paused");
    const [goalEventId] = await goalQueueEventIds(first.threadId);
    expect(goalEventId).toBeDefined();
    const events = await waitForThreadMessages(
      actor,
      first.threadId,
      (items) => {
        return items.some((event) => {
          return (
            event.eventType === "input.rejected" &&
            event.revokesEventId === goalEventId
          );
        });
      },
    );
    const rejectedGoalEvent = events.events.find((event) => {
      return (
        event.eventType === "input.rejected" &&
        event.revokesEventId === goalEventId
      );
    });
    if (rejectedGoalEvent?.eventType !== "input.rejected") {
      throw new Error("Expected the failed goal event to be rejected");
    }
    expect(rejectedGoalEvent).toMatchObject({
      eventType: "input.rejected",
      content: null,
      goalSnapshot: { objectiveBrief: "pause after claim failure" },
    });
    expect(chatEventDisplayText(rejectedGoalEvent)).toBe(
      "pause after claim failure",
    );
    expect(JSON.stringify(rejectedGoalEvent?.userMessage)).not.toContain(
      rejectedGoalEvent.error,
    );
    expect(rejectedGoalEvent).not.toHaveProperty("runId");
    await expect(goalRunIds(first.threadId)).resolves.toHaveLength(0);
  }, 90_000);

  it("starts a fresh goal session after current policy changes framework", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await enableGoalWorkflows(actor);
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await startChatRun(actor, {
      agentId,
      prompt: "finish before the goal route changes framework",
    });
    const objective = "Continue autonomously through the current model route";
    await createGoalForRun(actor, first.runId, objective);

    const provider = await misc.upsertOrgModelProvider(
      actor,
      { type: "openai-api-key", secret: "goal-openai-key" },
      [201],
    );
    if (provider.status !== 201) {
      throw new Error("Expected the goal OpenAI provider to be created");
    }
    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.6-terra",
        isDefault: true,
        defaultProviderType: "openai-api-key",
        credentialScope: "org",
        modelProviderId: provider.body.provider.id,
      },
    ]);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "completed before the goal route changed"),
    ]);

    const sandboxHeaders = await claimChatRun(runnerGroup, first.runId);
    await completeChatRunOk(first.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });

    const messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return isGoalContinuationUserMessage(message, objective);
        });
      },
    );
    const continuation = userMessages(messages.events).find((message) => {
      return isGoalContinuationUserMessage(message, objective);
    });
    if (!continuation?.runId) {
      throw new Error("Expected goal continuation run id");
    }
    const goalContext = await waitForRunContext(actor, continuation.runId);
    expect(goalContext.body.sessionId).toBeNull();
    expect(goalContext.body.environment.OPENAI_MODEL).toBe("gpt-5.6-terra");
    expect(goalContext.body.environment.ANTHROPIC_MODEL).toBeUndefined();

    await api.requestCancelRun(actor, continuation.runId, [200]);
    await waitForRunStatus(actor, continuation.runId, "cancelled");
    await flushWaitUntilForTest();
  }, 90_000);

  it("admits a user message while the pending goal run is being prepared", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await enableGoalWorkflows(actor);
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await startChatRun(actor, {
      agentId,
      prompt: "finish before a queued user interruption",
    });
    const goalObjective = "keep making autonomous progress";
    const goalBrief = goalObjective;
    await createGoalForRun(actor, first.runId, goalObjective);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "completed before the queued message"),
    ]);

    const goalRunPreparationStarted = createDeferredPromise<void>(
      context.signal,
    );
    const releaseGoalRunPreparation = deferredGate();
    useSecretKmsProbe((command) => {
      if (!goalRunPreparationStarted.settled()) {
        goalRunPreparationStarted.resolve(undefined);
      }
      return releaseGoalRunPreparation.wait().then(() => {
        return generateDataKeyOutput(command);
      });
    });

    const sandboxHeaders = await claimChatRun(runnerGroup, first.runId);
    await completeChatRunOk(first.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });
    await goalRunPreparationStarted.promise;

    const userMessageId = randomUUID();
    const [userRun] = await Promise.all([
      startChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "user message admitted during goal run preparation",
        clientEventId: userMessageId,
      }),
      waitForThreadMessages(actor, first.threadId, (events) => {
        return events.some((event) => {
          return (
            event.id === userMessageId && event.eventType === "input.prompt"
          );
        });
      }).finally(() => {
        releaseGoalRunPreparation.release();
      }),
    ]);

    let goalEventId: string | undefined;
    await expect
      .poll(async () => {
        const [eventId] = await goalQueueEventIds(first.threadId);
        goalEventId = eventId;
        return eventId;
      })
      .toBeDefined();
    if (!goalEventId) {
      throw new Error("Expected a pending goal queue event");
    }

    const pendingPage = await chat.listThreadEvents(actor, first.threadId);
    expect(pendingPage.events).toContainEqual(
      expect.objectContaining({
        id: goalEventId,
        eventType: "input.goal",
        content: null,
        goalSnapshot: { objectiveBrief: goalBrief },
      }),
    );
    expect(
      userMessages(pendingPage.events).find((message) => {
        return isGoalContinuationUserMessage(message, goalBrief);
      }),
    ).toBeUndefined();
    expect(userRun.runId).toBeDefined();
    await expect(goalRunIds(first.threadId)).resolves.toHaveLength(0);

    const paused = await accept(
      goalsClient().pause({
        headers: zeroGoalHeaders(actor, userRun.runId),
      }),
      [200],
    );
    expect(paused.body.status).toBe("paused");

    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "completed after the goal was paused"),
    ]);
    const userRunHeaders = await claimChatRun(runnerGroup, userRun.runId);
    await completeChatRunOk(userRun.runId, userRunHeaders, {
      lastEventSequence: 0,
    });
    const rejected = await waitForThreadMessages(
      actor,
      first.threadId,
      (events) => {
        return events.some((event) => {
          return (
            event.eventType === "input.rejected" &&
            event.revokesEventId === goalEventId
          );
        });
      },
    );
    const rejectedGoalEvent = rejected.events.find((event) => {
      return (
        event.eventType === "input.rejected" &&
        event.revokesEventId === goalEventId
      );
    });
    expect(rejectedGoalEvent).toMatchObject({
      eventType: "input.rejected",
    });
    expect(rejectedGoalEvent).not.toHaveProperty("runId");
    await expect(goalRunIds(first.threadId)).resolves.toHaveLength(0);
    await flushWaitUntilForTest();
  }, 90_000);

  it("marks an auto-sent follow-up when org concurrency queues the new run", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "2");

    const first = await startChatRun(actor, {
      agentId,
      prompt: "finish before auto-send queues",
    });
    const blocker = await startChatRun(actor, {
      agentId,
      prompt: "hold org concurrency open",
    });
    await waitForRunStatus(actor, first.runId, "pending");
    await waitForRunStatus(actor, blocker.runId, "pending");

    await queueChatMessage(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "queued while org cap is full",
    });
    const queuedBeforeComplete = await chat.listThreadEvents(
      actor,
      first.threadId,
    );
    const queued = userMessages(queuedBeforeComplete.events).find((message) => {
      return chatEventDisplayText(message) === "queued while org cap is full";
    });
    if (!queued) {
      throw new Error("Expected the queued user message to be listed");
    }

    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const sandboxHeaders = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([assistantEvent(0, "anchor completed")]);
    await completeChatRunOk(first.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });

    const afterAutoSend = await waitForThreadMessages(
      actor,
      first.threadId,
      (messages) => {
        const claimed = userMessages(messages).find((message) => {
          return (
            message.revokesEventId === queued.id && message.runId !== undefined
          );
        });
        return (
          claimed !== undefined &&
          assistantMessages(messages).some((message) => {
            return (
              message.runId === claimed.runId &&
              message.runEventId === "queue:queued"
            );
          })
        );
      },
    );
    const claimed = userMessages(afterAutoSend.events).find((message) => {
      return message.revokesEventId === queued.id;
    });
    if (!claimed?.runId) {
      throw new Error("Expected the queued message to auto-send");
    }
    const marker = assistantMessages(afterAutoSend.events).find((message) => {
      return (
        message.runId === claimed.runId && message.runEventId === "queue:queued"
      );
    });
    if (!marker) {
      throw new Error("Expected an assistant queue marker");
    }
    expect(marker).toMatchObject({
      content: "Waiting in queue...",
      runId: claimed.runId,
    });

    await api.requestCancelRun(actor, blocker.runId, [200]);
    await waitForRunStatus(actor, blocker.runId, "cancelled");
    await waitForRunStatus(actor, claimed.runId, "pending");
    await api.requestCancelRun(actor, claimed.runId, [200]);
    await waitForRunStatus(actor, claimed.runId, "cancelled");
    await flushWaitUntilForTest();
  }, 90_000);
});

describe("CHAT-02: chat output extraction and progress callbacks", () => {
  it("uses DB-complete assistant output for queued auto-send without querying Axiom output", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await startChatRun(actor, {
      agentId,
      prompt: "stream before queued follow-up",
    });
    await queueChatMessage(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "queued after streamed output",
    });
    const firstHeaders = await claimChatRun(runnerGroup, first.runId);

    await webhooks.requestAgentEvents(
      {
        runId: first.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: {
              id: "msg_bdd_db_complete",
              content: [{ type: "text", text: "DB-complete streamed answer" }],
            },
          },
          { type: "system", sequenceNumber: 1 },
        ],
      },
      firstHeaders,
      [200],
    );
    context.mocks.axiom.query.mockClear();
    context.mocks.axiom.query.mockImplementation((apl: unknown) => {
      const query = typeof apl === "string" ? apl : "";
      if (query.includes("['agent-run-events']")) {
        throw new Error("DB-complete output should not query Axiom");
      }
      return Promise.resolve([]);
    });

    await completeChatRunOk(first.runId, firstHeaders, {
      lastEventSequence: 1,
    });

    const messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (threadMessages) => {
        return userMessages(threadMessages).some((message) => {
          return (
            chatEventDisplayText(message) === "queued after streamed output" &&
            message.runId !== undefined
          );
        });
      },
    );
    expect(chatOutputAxiomQueryCalls()).toHaveLength(0);
    expect(
      eventBackedContents(messages.events, first.runId).map((message) => {
        return message.content;
      }),
    ).toStrictEqual(["DB-complete streamed answer"]);
    expect(
      lifecycleMarkers(messages.events, first.runId, "completed"),
    ).toHaveLength(1);

    const claimed = userMessages(messages.events).find((message) => {
      return (
        chatEventDisplayText(message) === "queued after streamed output" &&
        message.runId !== undefined
      );
    });
    if (!claimed?.runId) {
      throw new Error("Expected queued message to auto-send");
    }
    const timingEvents = await expectChatCallbackPreCreateTimingActions(
      claimed.runId,
      [
        "api_dispatch_pre_create_zero_chat_callback_load_terminal",
        "api_dispatch_pre_create_zero_chat_callback_prepare_completed",
        "api_dispatch_pre_create_zero_chat_callback_load_db_output_state",
        "api_dispatch_pre_create_zero_chat_callback_db_output_complete",
        "api_dispatch_pre_create_zero_chat_callback_insert_lifecycle_marker",
        "api_dispatch_pre_create_zero_chat_callback_load_followup_context",
        "api_dispatch_pre_create_zero_chat_callback_auto_send_load_thread",
        "api_dispatch_pre_create_zero_chat_callback_auto_send_lookup_queued_message",
        "api_dispatch_pre_create_zero_chat_callback_auto_send_build_input",
        "api_dispatch_pre_create_zero_chat_callback_auto_send_create_run",
        "api_dispatch_pre_create_zero_chat_callback_auto_send_publish_signals",
      ],
    );
    expectNoChatCallbackPreCreateTimingActions(timingEvents, [
      "api_dispatch_pre_create_zero_chat_callback_query_output_events",
      "api_dispatch_pre_create_zero_chat_callback_insert_assistant_items",
    ]);
  }, 90_000);

  it("falls back to Axiom when DB assistant output is not complete through the terminal sequence", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const run = await startChatRun(actor, {
      agentId,
      prompt: "partial streamed output",
    });
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    await webhooks.requestAgentEvents(
      {
        runId: run.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: {
              id: "msg_bdd_partial_0",
              content: [{ type: "text", text: "Partial streamed answer" }],
            },
          },
        ],
      },
      sandboxHeaders,
      [200],
    );

    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "Partial streamed answer"),
      assistantEvent(1, "Terminal answer from Axiom"),
    ]);
    context.mocks.axiom.query.mockClear();
    await completeChatRunOk(run.runId, sandboxHeaders, {
      lastEventSequence: 1,
    });

    const messages = await waitForThreadMessages(
      actor,
      run.threadId,
      (threadMessages) => {
        return eventBackedContents(threadMessages, run.runId).length === 2;
      },
    );
    expect(chatOutputAxiomQueryCalls()).toHaveLength(1);
    expect(
      eventBackedContents(messages.events, run.runId).map((message) => {
        return message.content;
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        "Partial streamed answer",
        "Terminal answer from Axiom",
      ]),
    );
  }, 90_000);

  it("skips Axiom for DB-complete no-output runs and falls back for result-only output", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const silent = await startChatRun(actor, {
      agentId,
      prompt: "silent streamed run",
    });
    const silentHeaders = await claimChatRun(runnerGroup, silent.runId);
    await webhooks.requestAgentEvents(
      {
        runId: silent.runId,
        events: [
          {
            type: "user",
            sequenceNumber: 0,
            message: {
              content: [
                {
                  type: "text",
                  text: "non-assistant text must not become assistant output",
                },
              ],
            },
          },
        ],
      },
      silentHeaders,
      [200],
    );
    context.mocks.axiom.query.mockClear();
    context.mocks.axiom.query.mockImplementation((apl: unknown) => {
      const query = typeof apl === "string" ? apl : "";
      if (query.includes("['agent-run-events']")) {
        throw new Error("DB-complete no-output run should not query Axiom");
      }
      return Promise.resolve([]);
    });

    await completeChatRunOk(silent.runId, silentHeaders, {
      lastEventSequence: 0,
    });
    let messages = await waitForThreadMessages(
      actor,
      silent.threadId,
      (threadMessages) => {
        return (
          lifecycleMarkers(threadMessages, silent.runId, "completed").length ===
          1
        );
      },
    );
    expect(chatOutputAxiomQueryCalls()).toHaveLength(0);
    expect(eventBackedContents(messages.events, silent.runId)).toHaveLength(0);
    await flushWaitUntilForTest();
    expect(firstAssistantMessageEventsForRun(silent.runId)).toStrictEqual([]);

    const resultOnly = await startChatRun(actor, {
      agentId,
      threadId: silent.threadId,
      prompt: "result-only streamed run",
    });
    const resultOnlyHeaders = await claimChatRun(runnerGroup, resultOnly.runId);
    await webhooks.requestAgentEvents(
      {
        runId: resultOnly.runId,
        events: [
          {
            type: "result",
            sequenceNumber: 0,
            result: "webhook result text is not stored in materialization",
          },
        ],
      },
      resultOnlyHeaders,
      [200],
    );
    chatCallbacks.mockChatOutputEvents([
      resultEvent(0, "Axiom result fallback answer"),
    ]);
    context.mocks.axiom.query.mockClear();

    await completeChatRunOk(resultOnly.runId, resultOnlyHeaders, {
      lastEventSequence: 0,
    });
    messages = await waitForThreadMessages(
      actor,
      silent.threadId,
      (threadMessages) => {
        return (
          eventBackedContents(threadMessages, resultOnly.runId).length === 1
        );
      },
    );
    expect(chatOutputAxiomQueryCalls()).toHaveLength(1);
    expect(
      eventBackedContents(messages.events, resultOnly.runId).map((message) => {
        return message.content;
      }),
    ).toStrictEqual(["Axiom result fallback answer"]);
    await flushWaitUntilForTest();
    expect(firstAssistantMessageEventsForRun(resultOnly.runId)).toHaveLength(1);
  }, 90_000);

  it("extracts assistant output from Codex items and result fallbacks, skips non-events, and acknowledges progress without reading events", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const routeRequests = chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await startChatRun(actor, {
      agentId,
      prompt: "progress probe",
    });
    const firstHeaders = await claimChatRun(runnerGroup, first.runId);
    await expect
      .poll(() => {
        return context.mocks.ably.publish.mock.calls.some((call) => {
          return call[0] === `chatThreadMessageCreated:${first.threadId}`;
        });
      })
      .toBe(true);
    await expect
      .poll(() => {
        return context.mocks.ably.publish.mock.calls.some((call) => {
          return (
            call[0] === `chatThreadRunCreated:${first.threadId}` &&
            call[1] === null
          );
        });
      })
      .toBe(true);
    context.mocks.axiom.query.mockClear();
    context.mocks.ably.publish.mockClear();
    await webhooks.requestAgentHeartbeat(
      { runId: first.runId },
      firstHeaders,
      [200],
    );

    expect(routeRequests()).toBe(0);
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
    const progressMessages = await chat.listThreadEvents(actor, first.threadId);
    const progressUserMessages = userMessages(progressMessages.events);
    expect(progressUserMessages).toHaveLength(2);
    const progressOriginal = progressUserMessages.find((message) => {
      return message.id === first.messageId;
    });
    expect(progressOriginal?.runId).toBeUndefined();
    expect(progressUserMessages).toContainEqual(
      expect.objectContaining({
        runId: first.runId,
        revokesEventId: first.messageId,
      }),
    );

    // Blank assistant text, non-agent_message Codex items, and result-shaped
    // fields on non-result events are skipped.
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, ""),
      {
        eventType: "item.completed",
        sequenceNumber: 1,
        eventData: { item: { type: "tool_call", text: "internal tool text" } },
      },
      {
        eventType: "result",
        sequenceNumber: 2,
        eventData: { result: "final fallback answer" },
      },
      {
        eventType: "item.completed",
        sequenceNumber: 3,
        eventData: {
          item: { type: "tool_call", text: "internal tool text" },
          result: "tool result must not become chat output",
        },
      },
      resultEvent(4, "future result must not become chat output"),
    ]);
    await completeChatRunOk(first.runId, firstHeaders, {
      lastEventSequence: 3,
    });

    let messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (threadMessages) => {
        return eventBackedContents(threadMessages, first.runId).length === 1;
      },
    );
    expect(
      eventBackedContents(messages.events, first.runId).map((message) => {
        return message.content;
      }),
    ).toStrictEqual(["final fallback answer"]);

    const second = await startChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "codex turn",
    });
    const secondHeaders = await claimChatRun(runnerGroup, second.runId);
    chatCallbacks.mockChatOutputEvents([
      {
        eventType: "item.completed",
        sequenceNumber: 0,
        eventData: { item: { type: "agent_message", text: "Codex answer" } },
      },
    ]);
    await completeChatRunOk(second.runId, secondHeaders, {
      lastEventSequence: 0,
    });

    messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (threadMessages) => {
        return eventBackedContents(threadMessages, second.runId).length === 1;
      },
    );
    expect(
      eventBackedContents(messages.events, second.runId).map((message) => {
        return message.content;
      }),
    ).toStrictEqual(["Codex answer"]);

    const third = await startChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "streamed turn",
    });
    const thirdHeaders = await claimChatRun(runnerGroup, third.runId);
    await webhooks.requestAgentEvents(
      {
        runId: third.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: {
              id: "msg_bdd_streamed",
              content: [{ type: "text", text: "Already streamed." }],
            },
          },
        ],
      },
      thirdHeaders,
      [200],
    );
    chatCallbacks.mockChatOutputEvents([
      resultEvent(0, "Unknown command: /aaa"),
    ]);
    await completeChatRunOk(third.runId, thirdHeaders, {
      lastEventSequence: 0,
    });

    messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (threadMessages) => {
        return eventBackedContents(threadMessages, third.runId).length === 1;
      },
    );
    expect(
      eventBackedContents(messages.events, third.runId).map((message) => {
        return message.content;
      }),
    ).toStrictEqual(["Already streamed."]);

    const beforeTitle = await readThreadTitleFromEvents(actor, first.threadId);
    expect(beforeTitle).toBeNull();
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    chatCallbacks.mockOpenRouterFailure();
    const fourth = await startChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "title failure turn",
    });
    const fourthHeaders = await claimChatRun(runnerGroup, fourth.runId);
    chatCallbacks.mockChatOutputEvents([resultEvent(0, "Some result")]);
    await completeChatRunOk(fourth.runId, fourthHeaders, {
      lastEventSequence: 0,
    });

    expect((await api.readRun(actor, fourth.runId)).status).toBe("completed");
    messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (threadMessages) => {
        return (
          lifecycleMarkers(threadMessages, fourth.runId, "completed").length ===
          1
        );
      },
    );
    expect(
      lifecycleMarkers(messages.events, fourth.runId, "completed"),
    ).toHaveLength(1);
    await expect(
      readThreadTitleFromEvents(actor, first.threadId),
    ).resolves.toBe(beforeTitle);
  }, 90_000);
});

describe("CHAT-02: failed chat callbacks", () => {
  it("formats failed-run errors with escalation and notifies, without auto-sending", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await chatCallbacks.registerPushSubscription(actor);
    chatCallbacks.enableVapid();

    const actionableError =
      "No model provider configured. Run 'zero org model-provider setup' to configure one, or add environment variables to your vm0.yaml.";
    const usageLimitError =
      "Claude usage limit reached. Visit https://claude.ai/settings/usage or try again at 6:17 AM.";
    const rounds = [
      { prompt: "round one", error: actionableError },
      { prompt: "round two", error: "First runner failure" },
      { prompt: "round three", error: "Second runner failure" },
      { prompt: "round four", error: usageLimitError },
    ];

    let threadId: string | undefined;
    const runIds: string[] = [];
    for (const round of rounds) {
      const run = await startChatRun(actor, {
        agentId,
        prompt: round.prompt,
        ...(threadId === undefined ? {} : { threadId }),
      });
      threadId = run.threadId;
      runIds.push(run.runId);
      const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
      // Isolate failed-callback notifications from send-side background work.
      await flushWaitUntilForTest();
      expect(context.mocks.ably.publish).toHaveBeenCalledWith(
        `chatThreadRunCreated:${run.threadId}`,
        null,
      );
      context.mocks.ably.publish.mockClear();
      await failChatRun(run.runId, sandboxHeaders, round.error);
      // The complete webhook acknowledges before terminal callback work
      // finishes. Drain its tracked waitUntil work so both realtime assertions
      // cover the complete failed-run callback instead of a one-second window.
      await flushWaitUntilForTest();
      expect(context.mocks.ably.publish).toHaveBeenCalledWith(
        `chatThreadMessageCreated:${run.threadId}`,
        null,
      );
      expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
        `chatThreadRunCreated:${run.threadId}`,
        null,
      );
    }
    const reportRunId = runIds[2];
    if (!threadId || !reportRunId) {
      throw new Error("Expected four failed chat rounds");
    }

    const messages = await waitForThreadMessages(actor, threadId, (items) => {
      const failed = items.filter((message) => {
        return message.eventType === "run.failed";
      });
      return runIds.every((runId) => {
        return failed.some((message) => {
          return message.runId === runId && message.error !== undefined;
        });
      });
    });
    const users = userMessages(messages.events);
    const originals = users.filter((message) => {
      return message.runId === undefined;
    });
    const replacements = users.filter((message) => {
      return message.runId !== undefined;
    });
    expect(originals).toHaveLength(4);
    expect(replacements).toHaveLength(4);
    expect(
      replacements.every((replacement) => {
        return originals.some((original) => {
          return replacement.revokesEventId === original.id;
        });
      }),
    ).toBeTruthy();
    const failed = messages.events.filter((message) => {
      return message.eventType === "run.failed";
    });
    expect(
      runIds.map((runId) => {
        return failed.find((message) => {
          return message.runId === runId;
        })?.error;
      }),
    ).toStrictEqual([
      actionableError,
      "Oops, something went wrong. Please try again later.",
      `An unexpected error occurred. [Report this issue](/runs/${reportRunId}/report-error)`,
      usageLimitError,
    ]);
    expect(
      failed.find((message) => {
        return message.runId === runIds[0];
      })?.content,
    ).toBe(actionableError);
    expect(
      failed.find((message) => {
        return message.runId === runIds[3];
      })?.content,
    ).toBe(usageLimitError);

    expect(context.mocks.webpush.sendNotification).toHaveBeenCalledTimes(4);
    expect(
      pushPayload(context.mocks.webpush.sendNotification.mock.calls[1]),
    ).toMatchObject({
      title: "round two",
      body: "Task failed: Oops, something went wrong. Please try again later.",
      url: `/chats/${threadId}`,
    });
  }, 90_000);

  it("stores insufficient credits failures as the billing recovery marker", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const run = await startChatRun(actor, {
      agentId,
      prompt: "post-dispatch billing failure",
    });
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);

    await failChatRun(
      run.runId,
      sandboxHeaders,
      "INSUFFICIENT_CREDITS: Insufficient credits. Please add credits to continue.",
    );

    const page = await waitForThreadMessages(
      actor,
      run.threadId,
      (messages) => {
        return lifecycleMarkers(messages, run.runId, "failed").some(
          (message) => {
            return message.error === "insufficient_credits";
          },
        );
      },
    );
    const marker = lifecycleMarkers(page.events, run.runId, "failed")[0];
    expect(marker?.error).toBe("insufficient_credits");
    expect(marker?.content).toBe("insufficient_credits");
  }, 90_000);

  it("shows friendly Claude overload guidance while preserving the raw run error", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const rawOverloadError =
      "API Error: 529 Overloaded. This is a server-side issue, usually temporary - try again in a moment. If it persists, check https://status.claude.com.";

    const run = await startChatRun(actor, {
      agentId,
      prompt: "trigger claude overload",
      selectedModel: "claude-sonnet-4-6",
    });
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    await failChatRun(run.runId, sandboxHeaders, rawOverloadError);

    const page = await waitForThreadMessages(
      actor,
      run.threadId,
      (messages) => {
        return lifecycleMarkers(messages, run.runId, "failed").some(
          (message) => {
            return message.error?.includes("Claude Sonnet 4.6") ?? false;
          },
        );
      },
    );
    const marker = lifecycleMarkers(page.events, run.runId, "failed")[0];
    expect(marker?.error).toBe(
      "Claude Sonnet 4.6 is overloaded. Please wait a few minutes and try again, or switch to another model.",
    );
    expect(marker?.content).toBe(marker?.error);
    expect(marker?.error).not.toContain("status.claude.com");

    const rawRun = await api.readRun(actor, run.runId);
    expect(rawRun.error).toBe(rawOverloadError);
  }, 90_000);

  it("shows Claude Code credential recovery guidance for upstream auth 401s", async () => {
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const upstreamAuthError =
      "Failed to authenticate. API Error: 401 Invalid authentication credentials";

    async function failAndReadError(params: {
      readonly prompt: string;
      readonly selectedModel?: string;
      readonly orgRole?: TestOrgRole;
      readonly configureProvider?: (
        fixture: EntitledChatActor,
      ) => Promise<void>;
    }): Promise<string> {
      const fixture =
        params.orgRole === "member"
          ? await entitledChatMemberActor()
          : await entitledChatActor();
      await params.configureProvider?.(fixture);
      const run = await startChatRun(fixture.actor, {
        agentId: fixture.agentId,
        prompt: params.prompt,
        ...(params.selectedModel === undefined
          ? {}
          : { selectedModel: params.selectedModel }),
      });
      const sandboxHeaders = await claimChatRun(fixture.runnerGroup, run.runId);
      if (params.orgRole !== undefined) {
        mockClerkMembership(
          context,
          fixture.actor,
          params.orgRole === "admin" ? "org:admin" : "org:member",
        );
      }
      await failChatRun(run.runId, sandboxHeaders, upstreamAuthError);

      const page = await waitForThreadMessages(
        fixture.actor,
        run.threadId,
        (messages) => {
          return lifecycleMarkers(messages, run.runId, "failed").some(
            (message) => {
              return message.error !== undefined;
            },
          );
        },
      );
      const marker = lifecycleMarkers(page.events, run.runId, "failed")[0];
      if (!marker?.error) {
        throw new Error("Expected failed chat callback to store an error");
      }
      expect(marker.content).toBe(marker.error);
      expect(marker.error).not.toContain("Report this issue");
      return marker.error;
    }

    await expect(
      failAndReadError({
        prompt: "subscription credential failed",
        selectedModel: "claude-opus-4-8",
        async configureProvider(fixture) {
          await misc.upsertPersonalModelProvider(
            fixture.actor,
            { type: "claude-code-oauth-token", secret: "sk-ant-oat-bdd" },
            [200, 201],
          );
          await api.updateOrgModelPolicies(fixture.actor, [
            {
              model: "claude-sonnet-4-6",
              isDefault: true,
              defaultProviderType: "anthropic-api-key",
              credentialScope: "org",
              modelProviderId: fixture.providerId,
            },
            {
              model: "claude-opus-4-8",
              isDefault: false,
              defaultProviderType: "claude-code-oauth-token",
              credentialScope: "member",
              modelProviderId: null,
            },
          ]);
        },
      }),
    ).resolves.toBe(
      "Claude Code subscription authentication failed. Reconnect Claude Code in Model Providers, then retry.\n\nReconnect Claude Code: http://localhost:3002/?settings=model",
    );
    await expect(
      failAndReadError({
        prompt: "org key failed for admin",
        orgRole: "admin",
      }),
    ).resolves.toBe(
      "Claude Code could not authenticate with the configured Anthropic API key. Update or replace the API key in Model Providers, then retry.\n\nOpen Model Providers: http://localhost:3002/?settings=model",
    );
    await expect(
      failAndReadError({
        prompt: "org key failed for member",
        orgRole: "member",
      }),
    ).resolves.toBe(
      "Claude Code could not authenticate with the configured Anthropic API key. Ask a workspace admin to update or replace the API key.\n\nShare with an admin: http://localhost:3002/?settings=model",
    );
  }, 90_000);
});

describe("CHAT-02: auto-send after failures", () => {
  it("uses structured failed messages for normal and queued incomplete-round context", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await startChatRun(actor, {
      agentId,
      prompt: "successful structured context anchor",
      selectedModel: "claude-sonnet-4-6",
    });
    const anchorHeaders = await claimChatRun(runnerGroup, anchor.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(anchor.runId, anchorHeaders);
    await flushWaitUntilForTest();

    const style = ILLUSTRATION_TEMPLATE_ITEMS[0];
    if (!style) {
      throw new Error("Expected a registered illustration style");
    }
    const generationTemplate: GenerationTemplateRequest = {
      type: "illustration",
      selection: { illustrationStyleId: style.illustrationStyleId },
    };
    const userMessage: UserMessageDocument = {
      version: 1,
      parts: [
        {
          type: "template",
          titleSnapshot: style.title,
          template: generationTemplate,
        },
        { type: "text", text: "structured failed request" },
        {
          type: "feedback",
          quote: "The failed response omitted the owner",
          note: [{ type: "text", text: "Name the responsible owner" }],
        },
      ],
    };
    const templatePrompt = `Select ${style.title} illustration template`;
    const feedbackPrompt =
      "Feedback on this part of your reply:\n\n" +
      "> The failed response omitted the owner\n\nName the responsible owner";

    const failedForNormal = await startChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "stale failed legacy request",
      generationTemplate,
      userMessage,
    });
    const failedForNormalHeaders = await claimChatRun(
      runnerGroup,
      failedForNormal.runId,
    );
    await failChatRun(
      failedForNormal.runId,
      failedForNormalHeaders,
      "structured normal context failure",
    );
    await flushWaitUntilForTest();

    const normal = await startChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "normal incomplete context probe",
    });
    const normalContext = await waitForRunContext(actor, normal.runId);
    expect(normalContext.body.appendSystemPrompt).toContain(templatePrompt);
    expect(normalContext.body.appendSystemPrompt).toContain(feedbackPrompt);
    await api.requestCancelRun(actor, normal.runId, [200]);
    await waitForRunStatus(actor, normal.runId, "cancelled");
    await flushWaitUntilForTest();

    const failedForQueue = await startChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "second stale failed legacy request",
      generationTemplate,
      userMessage,
    });
    const failedForQueueHeaders = await claimChatRun(
      runnerGroup,
      failedForQueue.runId,
    );
    const queuedPrompt = "queued incomplete context probe";
    await queueChatMessage(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: queuedPrompt,
    });
    await failChatRun(
      failedForQueue.runId,
      failedForQueueHeaders,
      "structured queued context failure",
    );

    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            chatEventDisplayText(message) === queuedPrompt &&
            message.runId !== undefined
          );
        });
      },
    );
    const promoted = userMessages(messages.events).find((message) => {
      return (
        chatEventDisplayText(message) === queuedPrompt &&
        message.runId !== undefined
      );
    });
    if (!promoted?.runId) {
      throw new Error("Expected the queued probe to be promoted");
    }
    const queuedContext = await waitForRunContext(actor, promoted.runId);
    expect(queuedContext.body.appendSystemPrompt).toContain(templatePrompt);
    expect(queuedContext.body.appendSystemPrompt).toContain(feedbackPrompt);

    await api.requestCancelRun(actor, promoted.runId, [200]);
    await waitForRunStatus(actor, promoted.runId, "cancelled");
  }, 90_000);

  it("uses the latest unrevoked successful event as the incomplete-round boundary", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const followupGate = deferredGate();
    let followupRequests = 0;

    const anchor = await startChatRun(actor, {
      agentId,
      prompt: "successful boundary anchor",
    });
    const anchorHeaders = await claimChatRun(runnerGroup, anchor.runId);
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    chatCallbacks.mockOpenRouterCompletions(async (body) => {
      const systemContent = body.messages[0]?.content ?? "";
      if (systemContent.includes("concise follow-up prompts")) {
        followupRequests += 1;
        await followupGate.wait();
        return JSON.stringify([
          { prompt: "Inspect the failed round", kind: "talk" },
        ]);
      }
      if (systemContent.includes("Generate a short, descriptive title")) {
        return "Revoked Boundary";
      }
      return "Boundary summary";
    });
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "successful boundary answer"),
    ]);
    await completeChatRunOk(anchor.runId, anchorHeaders, {
      lastEventSequence: 0,
    });
    await waitForThreadMessages(actor, anchor.threadId, (messages) => {
      return lifecycleMarkers(messages, anchor.runId, "completed").length > 0;
    });
    await expect
      .poll(() => {
        return followupRequests;
      })
      .toBe(1);

    const firstFailedPrompt = "failed before the late successful follow-up";
    const firstFailed = await startChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: firstFailedPrompt,
    });
    const firstFailedHeaders = await claimChatRun(
      runnerGroup,
      firstFailed.runId,
    );
    await failChatRun(
      firstFailed.runId,
      firstFailedHeaders,
      "first boundary failure",
    );
    await waitForThreadMessages(actor, anchor.threadId, (messages) => {
      return lifecycleMarkers(messages, firstFailed.runId, "failed").length > 0;
    });

    followupGate.release();
    const afterFollowup = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (messages) => {
        return recommendedFollowupMessages(messages, anchor.runId).length > 0;
      },
    );
    const lateFollowup = recommendedFollowupMessages(
      afterFollowup.events,
      anchor.runId,
    )[0];
    if (!lateFollowup) {
      throw new Error("Expected the delayed recommended follow-up event");
    }
    await flushWaitUntilForTest();

    const revokingFailure = await startChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "revoke the late successful follow-up",
      revokesEventId: lateFollowup.id,
    });
    const revokingFailureHeaders = await claimChatRun(
      runnerGroup,
      revokingFailure.runId,
    );
    await failChatRun(
      revokingFailure.runId,
      revokingFailureHeaders,
      "revoking boundary failure",
    );
    await waitForThreadMessages(actor, anchor.threadId, (messages) => {
      return (
        lifecycleMarkers(messages, revokingFailure.runId, "failed").length > 0
      );
    });

    const probe = await startChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "probe the revoked boundary",
    });
    const probeContext = await waitForRunContext(actor, probe.runId);
    expect(probeContext.body.appendSystemPrompt).toContain(firstFailedPrompt);

    await api.requestCancelRun(actor, probe.runId, [200]);
    await waitForRunStatus(actor, probe.runId, "cancelled");
  }, 90_000);

  it("auto-sends the queued message after a failure, carrying attachments, incomplete-round context, and the continued session", async () => {
    const { actor, agentId, runnerGroup, storage } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await startChatRun(actor, {
      agentId,
      prompt: "start the session",
      selectedModel: "claude-sonnet-4-6",
    });
    const firstHeaders = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstHeaders);
    // This journey verifies failed-run auto-send context, not overlap with the
    // successful anchor's detached terminal materialization. Drain the tracked
    // waitUntil work so later lifecycle/follow-up rows cannot move its boundary
    // after the failed run starts; callback ordering has dedicated gate coverage.
    await flushWaitUntilForTest();

    const completedFirst = await api.readRun(actor, first.runId);
    expect(completedFirst.result?.agentSessionId).toMatch(/[0-9a-f-]{36}/);

    const contextUpload = await chat.prepareUpload(actor, {
      filename: "incomplete-context.txt",
      contentType: "text/plain",
      size: 18,
    });
    storage.addObject({
      bucket: USER_ARTIFACTS_BUCKET,
      key: `artifacts/${actor.userId}/${contextUpload.id}/incomplete-context.txt`,
      size: 18,
    });
    const contextFile = await chat.completeUpload(actor, {
      id: contextUpload.id,
    });

    const longPrompt = `Refine the analysis ${"x".repeat(4200)}`;
    const second = await startChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: longPrompt,
      attachFiles: [
        {
          id: contextFile.id,
          filename: contextFile.filename,
          contentType: contextFile.contentType,
          size: contextFile.size,
        },
      ],
    });
    const secondHeaders = await claimChatRun(runnerGroup, second.runId);

    const queuedUpload = await chat.prepareUpload(actor, {
      filename: "queued-notes.txt",
      contentType: "text/plain",
      size: 11,
    });
    storage.addObject({
      bucket: USER_ARTIFACTS_BUCKET,
      key: `artifacts/${actor.userId}/${queuedUpload.id}/queued-notes.txt`,
      size: 11,
    });
    const queuedFile = await chat.completeUpload(actor, {
      id: queuedUpload.id,
    });
    const queuedContent = "queued with files";
    await queueChatMessage(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "queued with files",
      attachFiles: [
        {
          id: queuedFile.id,
          filename: queuedFile.filename,
          contentType: queuedFile.contentType,
          size: queuedFile.size,
        },
      ],
    });

    await chatCallbacks.registerPushSubscription(actor);
    chatCallbacks.enableVapid();
    const pushGate = deferredGate();
    context.mocks.webpush.sendNotification.mockImplementation(() => {
      return pushGate.wait();
    });

    context.mocks.ably.publish.mockClear();
    await failChatRun(second.runId, secondHeaders, "boom");

    const messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.eventType === "input.prompt" &&
            chatEventDisplayText(message) === queuedContent &&
            message.runId !== undefined
          );
        });
      },
    );
    const claimed = userMessages(messages.events).find(
      (message): message is PromptMessage => {
        return (
          message.eventType === "input.prompt" &&
          chatEventDisplayText(message) === queuedContent &&
          message.runId !== undefined
        );
      },
    );
    if (!claimed?.runId) {
      throw new Error(
        "Expected the queued message to be auto-claimed after the failure",
      );
    }
    expect(claimed.runId).not.toBe(second.runId);
    await expectZeroPreCreateSource(claimed.runId, "chat_callback_auto_send");
    const timingEvents = await expectChatCallbackPreCreateTimingActions(
      claimed.runId,
      [
        "api_dispatch_pre_create_zero_chat_callback_load_terminal",
        "api_dispatch_pre_create_zero_chat_callback_prepare_failed",
        "api_dispatch_pre_create_zero_chat_callback_auto_send_load_thread",
        "api_dispatch_pre_create_zero_chat_callback_auto_send_lookup_queued_message",
        "api_dispatch_pre_create_zero_chat_callback_auto_send_load_agent",
        "api_dispatch_pre_create_zero_chat_callback_auto_send_build_input",
        "api_dispatch_pre_create_zero_chat_callback_auto_send_create_run",
        "api_dispatch_pre_create_zero_chat_callback_auto_send_publish_signals",
      ],
    );
    expectNoChatCallbackPreCreateTimingActions(timingEvents, [
      "api_dispatch_pre_create_zero_chat_callback_prepare_completed",
      "api_dispatch_pre_create_zero_chat_callback_load_db_output_state",
      "api_dispatch_pre_create_zero_chat_callback_db_output_complete",
      "api_dispatch_pre_create_zero_chat_callback_db_output_incomplete",
      "api_dispatch_pre_create_zero_chat_callback_query_output_events",
      "api_dispatch_pre_create_zero_chat_callback_insert_lifecycle_marker",
      "api_dispatch_pre_create_zero_chat_callback_load_followup_context",
    ]);
    expect(claimed.attachFiles).toHaveLength(1);
    expect(claimed.attachFiles?.[0]).toMatchObject({
      filename: "queued-notes.txt",
      url: expect.stringContaining(queuedFile.id),
    });
    await expect
      .poll(() => {
        return context.mocks.ably.publish.mock.calls.some((call) => {
          return call[0] === `chatThreadRunCreated:${first.threadId}`;
        });
      })
      .toBe(true);

    const autoContext = await waitForRunContext(actor, claimed.runId);
    expect(autoContext.body.prompt).toContain("queued with files");
    expect(autoContext.body.prompt).toContain(
      "[Web file] queued-notes.txt (text/plain)",
    );
    expect(autoContext.body.prompt).toContain(`[ID] ${queuedFile.id}`);
    const appended = autoContext.body.appendSystemPrompt ?? "";
    expect(appended).toContain("# Incomplete Rounds Context");
    expect(appended).toContain("RUN_STATUS: failed");
    expect(appended).toContain("...[truncated]");
    expect(appended).toContain(
      `[Web file] ${contextFile.filename} (${contextFile.contentType})\n   [ID] ${contextFile.id}`,
    );
    expect(appended).not.toContain("# Web Chat Run Context");
    expect(autoContext.body.sessionId).toBe(`bdd-cli-${first.runId}`);

    pushGate.release();
    await expect
      .poll(() => {
        return context.mocks.webpush.sendNotification.mock.calls.length;
      })
      .toBe(1);

    await queueChatMessage(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "queued after duplicate failed callback",
    });
    const afterFailureSecondQueue = await chat.listThreadEvents(
      actor,
      first.threadId,
    );
    const duplicateFailureProbeQueued = userMessages(
      afterFailureSecondQueue.events,
    ).find((message) => {
      return (
        chatEventDisplayText(message) ===
        "queued after duplicate failed callback"
      );
    });
    if (!duplicateFailureProbeQueued) {
      throw new Error("Expected the duplicate failure probe message to queue");
    }

    await failChatRun(second.runId, secondHeaders, "boom");
    await flushWaitUntilForTest();
    await expect
      .poll(() => {
        return context.mocks.webpush.sendNotification.mock.calls.length;
      })
      .toBe(1);
    const afterDuplicateFailure = await chat.listThreadEvents(
      actor,
      first.threadId,
    );
    const duplicateFailureProbeClaimed = userMessages(
      afterDuplicateFailure.events,
    ).filter((message) => {
      return message.revokesEventId === duplicateFailureProbeQueued.id;
    });
    expect(duplicateFailureProbeClaimed).toHaveLength(0);
    const duplicateFailureProbeStillQueued = userMessages(
      afterDuplicateFailure.events,
    ).find((message) => {
      return message.id === duplicateFailureProbeQueued.id;
    });
    expect(duplicateFailureProbeStillQueued?.runId).toBeUndefined();

    await api.requestCancelRun(actor, claimed.runId, [200]);
    await waitForRunStatus(actor, claimed.runId, "cancelled");
  }, 90_000);

  it("keeps only the newest 20 incomplete rounds for normal and queued callback sends", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await startChatRun(actor, {
      agentId,
      prompt: "successful frontier anchor",
      selectedModel: "claude-sonnet-4-6",
    });
    const anchorHeaders = await claimChatRun(runnerGroup, anchor.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(anchor.runId, anchorHeaders);
    await flushWaitUntilForTest();

    const historyPrompts = Array.from({ length: 21 }, (_, index) => {
      return `incomplete frontier history ${String(index).padStart(2, "0")}`;
    });
    for (const prompt of historyPrompts) {
      const round = await startChatRun(actor, {
        agentId,
        threadId: anchor.threadId,
        prompt,
      });
      await api.requestCancelRun(actor, round.runId, [200]);
      await waitForRunStatus(actor, round.runId, "cancelled");
    }
    await flushWaitUntilForTest();

    const normalPrompt = "normal frontier probe";
    const normal = await startChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: normalPrompt,
    });
    const normalContext = await waitForRunContext(actor, normal.runId);
    const normalAppended = normalContext.body.appendSystemPrompt ?? "";
    expect(normalAppended).toContain("# Incomplete Rounds Context");
    expect(normalAppended.match(/^- RUN_STATUS:/gm) ?? []).toHaveLength(20);
    expect(normalAppended).not.toContain(historyPrompts[0]);
    expect(normalAppended).not.toContain("successful frontier anchor");
    for (const prompt of historyPrompts.slice(1)) {
      expect(normalAppended).toContain(prompt);
    }
    const normalPositions = historyPrompts.slice(1).map((prompt) => {
      return normalAppended.indexOf(prompt);
    });
    expect(normalPositions).toStrictEqual(
      [...normalPositions].sort((left, right) => {
        return left - right;
      }),
    );

    const normalHeaders = await claimChatRun(runnerGroup, normal.runId);
    const queuedPrompt = "queued callback frontier probe";
    await queueChatMessage(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: queuedPrompt,
    });
    await failChatRun(normal.runId, normalHeaders, "frontier probe failed");

    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            chatEventDisplayText(message) === queuedPrompt &&
            message.runId !== undefined
          );
        });
      },
    );
    const autoSent = userMessages(messages.events).find((message) => {
      return (
        chatEventDisplayText(message) === queuedPrompt &&
        message.runId !== undefined
      );
    });
    if (!autoSent?.runId) {
      throw new Error("Expected the queued frontier probe to auto-send");
    }

    const callbackContext = await waitForRunContext(actor, autoSent.runId);
    const callbackAppended = callbackContext.body.appendSystemPrompt ?? "";
    expect(callbackAppended).toContain("# Incomplete Rounds Context");
    expect(callbackAppended.match(/^- RUN_STATUS:/gm) ?? []).toHaveLength(20);
    expect(
      callbackAppended.match(/^- RUN_STATUS: cancelled$/gm) ?? [],
    ).toHaveLength(19);
    expect(
      callbackAppended.match(/^- RUN_STATUS: failed$/gm) ?? [],
    ).toHaveLength(1);
    expect(callbackAppended).not.toContain(historyPrompts[0]);
    expect(callbackAppended).not.toContain(historyPrompts[1]);
    expect(callbackAppended).toContain(normalPrompt);
    for (const prompt of historyPrompts.slice(2)) {
      expect(callbackAppended).toContain(prompt);
    }
    const callbackPositions = [...historyPrompts.slice(2), normalPrompt].map(
      (prompt) => {
        return callbackAppended.indexOf(prompt);
      },
    );
    expect(callbackPositions).toStrictEqual(
      [...callbackPositions].sort((left, right) => {
        return left - right;
      }),
    );

    await api.requestCancelRun(actor, autoSent.runId, [200]);
    await waitForRunStatus(actor, autoSent.runId, "cancelled");
    await flushWaitUntilForTest();
  }, 90_000);
});

describe("CHAT-02: auto-send across a model switch", () => {
  it("recovers a queued message through the current same-family workspace default", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await chatCallbacks.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-4-6",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "claude-opus-4-6",
        isDefault: false,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const titlePrompts: string[] = [];
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    chatCallbacks.mockOpenRouterCompletions((body) => {
      const systemContent = body.messages[0]?.content ?? "";
      if (systemContent.includes("Generate a short, descriptive title")) {
        titlePrompts.push(body.messages[1]?.content ?? "");
        return "Working with JSON";
      }
      return "Generated summary";
    });

    const firstPrompt = `How do I parse JSON? ${"p".repeat(4200)}`;
    const first = await startChatRun(actor, {
      agentId,
      prompt: firstPrompt,
      selectedModel: "claude-opus-4-6",
    });
    const firstHeaders = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "Use JSON.parse(str)."),
    ]);
    await completeChatRunOk(first.runId, firstHeaders, {
      lastEventSequence: 0,
    });

    const second = await startChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "And stringify?",
    });
    const secondHeaders = await claimChatRun(runnerGroup, second.runId);
    await queueChatMessage(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "queued before policy removal",
    });
    await chatCallbacks.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-4-6",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "Use JSON.stringify(value)."),
    ]);
    await completeChatRunOk(second.runId, secondHeaders, {
      lastEventSequence: 0,
    });

    const messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            chatEventDisplayText(message) === "queued before policy removal" &&
            message.runId !== undefined
          );
        });
      },
    );
    const claimed = userMessages(messages.events).find((message) => {
      return (
        chatEventDisplayText(message) === "queued before policy removal" &&
        message.runId !== undefined
      );
    });
    if (!claimed?.runId) {
      throw new Error(
        "Expected the queued message to be auto-claimed after policy removal",
      );
    }

    const autoContext = await waitForRunContext(actor, claimed.runId);
    const appended = autoContext.body.appendSystemPrompt ?? "";
    expect(appended).not.toContain("# Web Chat Run Context");
    expect(appended).not.toContain("# Incomplete Rounds Context");
    expect(autoContext.body.sessionId).toBe(`bdd-cli-${second.runId}`);
    expect(Object.keys(autoContext.body.environment)).toContain(
      "ANTHROPIC_API_KEY",
    );
    expect(autoContext.body.environment.ANTHROPIC_MODEL).toBe(
      "claude-sonnet-4-6",
    );

    const thread = await chat.readThread(actor, first.threadId);
    expect(thread).not.toHaveProperty("selectedModel");
    await expect(
      readThreadTitleFromEvents(actor, first.threadId),
    ).resolves.toBe("Working with JSON");
    const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
    expect(threadEvents.status).toBe(200);
    if (threadEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(
      threadEvents.body.events.filter((event) => {
        return (
          event.kind === "model_selection_updated" &&
          event.chatThreadId === first.threadId &&
          event.selectedModel === "claude-sonnet-4-6"
        );
      }),
    ).toHaveLength(1);

    expect(titlePrompts).toHaveLength(1);
    const initialTitlePrompt = titlePrompts[0];
    if (initialTitlePrompt === undefined) {
      throw new Error("Expected the initial send to request a thread title");
    }
    expect(initialTitlePrompt).toContain("How do I parse JSON?");
    expect(initialTitlePrompt).not.toContain("Use JSON.stringify(value).");

    await api.requestCancelRun(actor, claimed.runId, [200]);
    await waitForRunStatus(actor, claimed.runId, "cancelled");
  }, 90_000);

  it("resumes the CLI session by default when the queued model stays within the same family", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
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

    const first = await startChatRun(actor, {
      agentId,
      prompt: "start on opus before queueing a Claude family switch",
      selectedModel: "claude-opus-4-6",
    });
    const firstHeaders = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstHeaders);

    const second = await startChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "keep the opus session active",
    });
    const secondHeaders = await claimChatRun(runnerGroup, second.runId);
    await chat.updateThreadModelSelection(
      actor,
      first.threadId,
      "claude-sonnet-4-6",
    );
    await queueChatMessage(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "queue a sonnet follow-up",
    });
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(second.runId, secondHeaders);

    const messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            chatEventDisplayText(message) === "queue a sonnet follow-up" &&
            message.runId !== undefined
          );
        });
      },
    );
    const claimed = userMessages(messages.events).find((message) => {
      return (
        chatEventDisplayText(message) === "queue a sonnet follow-up" &&
        message.runId !== undefined
      );
    });
    if (!claimed?.runId) {
      throw new Error("Expected the queued message to be auto-claimed");
    }

    const autoContext = await waitForRunContext(actor, claimed.runId);
    expect(autoContext.body.sessionId).toBe(`bdd-cli-${second.runId}`);
    expect(autoContext.body.appendSystemPrompt ?? "").not.toContain(
      "# Web Chat Run Context",
    );
    expect(autoContext.body.environment.ANTHROPIC_MODEL).toBe(
      "claude-sonnet-4-6",
    );

    await api.requestCancelRun(actor, claimed.runId, [200]);
    await waitForRunStatus(actor, claimed.runId, "cancelled");
  }, 90_000);
});

describe("CHAT-02: thread deletion while a run is active", () => {
  it("skips terminal processing when the thread is gone", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const run = await startChatRun(actor, {
      agentId,
      prompt: "delete this thread",
    });
    await claimChatRun(runnerGroup, run.runId);
    await expect
      .poll(() => {
        return context.mocks.ably.publish.mock.calls.some((call) => {
          return call[0] === `chatThreadMessageCreated:${run.threadId}`;
        });
      })
      .toBe(true);
    await expect
      .poll(() => {
        return context.mocks.ably.publish.mock.calls.some((call) => {
          return call[0] === `chatThreadRunCreated:${run.threadId}`;
        });
      })
      .toBe(true);

    context.mocks.axiom.query.mockClear();
    context.mocks.ably.publish.mockClear();
    await chat.deleteThread(actor, run.threadId);
    await waitForRunStatus(actor, run.runId, "cancelled");
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
    const deletedRead = await chat.requestReadThread(
      actor,
      run.threadId,
      [404],
    );
    expect(deletedRead.status).toBe(404);
  }, 60_000);
});

describe("CHAT-02: push notification gating", () => {
  it("suppresses completed run pushes while the thread has an active goal", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await enableGoalWorkflows(actor);
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    chatCallbacks.enableVapid();
    await chatCallbacks.registerPushSubscription(actor);

    const run = await startChatRun(actor, {
      agentId,
      prompt: "complete while goal remains active",
    });
    await createGoalForRun(actor, run.runId, "keep working after this run");
    chatCallbacks.mockChatOutputEvents([]);
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    await completeChatRunOk(run.runId, sandboxHeaders);

    const messages = await waitForThreadMessages(
      actor,
      run.threadId,
      (threadMessages) => {
        return userMessages(threadMessages).some((message) => {
          return isGoalContinuationUserMessage(
            message,
            "keep working after this run",
          );
        });
      },
    );
    await flushWaitUntilForTest();
    expect(context.mocks.webpush.sendNotification).not.toHaveBeenCalled();

    const continuation = userMessages(messages.events).find((message) => {
      return isGoalContinuationUserMessage(
        message,
        "keep working after this run",
      );
    });
    if (!continuation?.runId) {
      throw new Error("Expected an active goal continuation run");
    }
    await api.requestCancelRun(actor, continuation.runId, [200]);
    await waitForRunStatus(actor, continuation.runId, "cancelled");
    await flushWaitUntilForTest();
    expect(context.mocks.webpush.sendNotification).not.toHaveBeenCalled();
  }, 60_000);

  it("suppresses failed run pushes while the thread has an active goal", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await enableGoalWorkflows(actor);
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    chatCallbacks.enableVapid();
    await chatCallbacks.registerPushSubscription(actor);

    const run = await startChatRun(actor, {
      agentId,
      prompt: "fail while goal remains active",
    });
    await createGoalForRun(actor, run.runId, "pause after this failure");
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    await failChatRun(run.runId, sandboxHeaders, "goal iteration failed");

    await expect
      .poll(async () => {
        const goal = await accept(
          goalsClient().get({
            headers: zeroGoalHeaders(actor, run.runId),
          }),
          [200],
        );
        return goal.body.status;
      })
      .toBe("paused");
    await flushWaitUntilForTest();
    expect(context.mocks.webpush.sendNotification).not.toHaveBeenCalled();
  }, 60_000);

  it("withholds pushes without VAPID keys and deletes stale subscriptions after gone responses", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const endpoint = await chatCallbacks.registerPushSubscription(actor);

    const first = await startChatRun(actor, {
      agentId,
      prompt: "no vapid yet",
    });
    const firstHeaders = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstHeaders);

    const messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (threadMessages) => {
        return (
          lifecycleMarkers(threadMessages, first.runId, "completed").length ===
          1
        );
      },
    );
    expect(eventBackedContents(messages.events, first.runId)).toHaveLength(0);
    expect(
      lifecycleMarkers(messages.events, first.runId, "completed"),
    ).toHaveLength(1);
    await flushWaitUntilForTest();
    expect(context.mocks.webpush.sendNotification).not.toHaveBeenCalled();

    chatCallbacks.enableVapid();
    context.mocks.webpush.sendNotification.mockRejectedValueOnce(
      new WebPushError("Gone", 410, {}, "", endpoint),
    );
    const second = await startChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "now with vapid",
    });
    const secondHeaders = await claimChatRun(runnerGroup, second.runId);
    await completeChatRunOk(second.runId, secondHeaders);

    await expect
      .poll(() => {
        return context.mocks.webpush.sendNotification.mock.calls.length;
      })
      .toBe(1);
    expect(
      pushPayload(context.mocks.webpush.sendNotification.mock.calls[0]),
    ).toMatchObject({
      title: "now with vapid",
      body: "Your task is complete",
      url: `/chats/${first.threadId}`,
    });
    await flushWaitUntilForTest();

    const third = await startChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "after stale cleanup",
    });
    const thirdHeaders = await claimChatRun(runnerGroup, third.runId);
    await completeChatRunOk(third.runId, thirdHeaders);
    await waitForThreadMessages(actor, first.threadId, (threadMessages) => {
      return (
        lifecycleMarkers(threadMessages, third.runId, "completed").length === 1
      );
    });
    expect(context.mocks.webpush.sendNotification).toHaveBeenCalledTimes(1);
  }, 60_000);
});
