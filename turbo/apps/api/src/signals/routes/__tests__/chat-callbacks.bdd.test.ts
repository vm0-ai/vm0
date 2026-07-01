import { createHash } from "node:crypto";

import { WebPushError } from "web-push";
import { PRESENTATION_TEMPLATE_ITEMS } from "@vm0/core";
import type {
  AttachFile,
  GenerationTemplateRequest,
  PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import type {
  TestChatMessagesStateActionBody,
  TestChatMessagesStateActionResponse,
} from "@vm0/api-contracts/contracts/test-chat-messages-state";
import { describe, expect, it, onTestFinished } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { testChatMessagesStateRoutes } from "../test-chat-messages-state";

/**
 * CHAT-02 / HOOK-01: signed chat run callbacks through real dispatch.
 *
 * Terminal callbacks in this file originate from the real internal dispatcher
 * (sandbox complete/cancel webhooks and the sandbox heartbeat route), so normal
 * app-internal dispatch does not depend on an HTTP self-call.
 */

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsAutomationsApi(context);
const chat = createChatFilesBddApi(context);
const webhooks = createWebhookCallbackApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const misc = createMiscRoutesApi(context);

const MODEL_FIRST_SELECTION_PROVIDER_ID =
  "00000000-0000-4000-8000-000000000000";
const USER_ARTIFACTS_BUCKET = "test-user-artifacts";
const CHAT_CALLBACK_PRE_CREATE_TIMING_PREFIX =
  "api_dispatch_pre_create_zero_chat_callback_";
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

type AssistantMessage = Extract<PagedChatMessage, { role: "assistant" }>;
type UserMessage = Extract<PagedChatMessage, { role: "user" }>;
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
    readonly threadId?: string;
    readonly selectedModel?: string;
    readonly attachFiles?: readonly AttachFile[];
  },
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const sent = await chat.requestSendMessage(
    actor,
    {
      agentId: body.agentId,
      prompt: body.prompt,
      ...(body.threadId === undefined ? {} : { threadId: body.threadId }),
      ...(body.attachFiles === undefined
        ? {}
        : { attachFiles: body.attachFiles }),
      ...(body.selectedModel === undefined
        ? { modelProvider: "anthropic-api-key" }
        : {
            modelSelection: {
              modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
              selectedModel: body.selectedModel,
            },
          }),
    },
    [201],
  );
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected the entitled chat send to create a run");
  }
  return { runId: sent.body.runId, threadId: sent.body.threadId };
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
  const sent = await chat.requestSendMessage(
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

async function claimChatRun(
  runnerGroup: string,
  runId: string,
): Promise<{ readonly authorization: string }> {
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
  return { authorization: `Bearer ${claim.body.sandboxToken}` };
}

async function waitForThreadMessages(
  actor: ApiTestUser,
  threadId: string,
  predicate: (messages: readonly PagedChatMessage[]) => boolean,
) {
  let page: Awaited<ReturnType<typeof chat.listThreadMessages>> | undefined;
  await expect
    .poll(
      async () => {
        page = await chat.listThreadMessages(actor, threadId);
        return predicate(page.messages);
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
      return (await chat.readThread(actor, threadId)).title;
    })
    .toBe(title);
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

function lifecycleMarkers(
  messages: readonly PagedChatMessage[],
  runId: string,
  event: "completed" | "failed" | "cancelled",
): AssistantMessage[] {
  return assistantMessages(messages).filter((message) => {
    return message.runId === runId && message.runLifecycleEvent === event;
  });
}

function publishedChatThreadRunFinished(threadId: string): boolean {
  return context.mocks.ably.publish.mock.calls.some((call) => {
    const payload = call[1];
    return (
      call[0] === "chatThreadRunFinished" &&
      payload !== null &&
      typeof payload === "object" &&
      "threadId" in payload &&
      payload.threadId === threadId
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

function requestChatMessagesState(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testChatMessagesStateRoutes,
  });
  return Promise.resolve(app.request(path, init));
}

async function postChatMessagesStateAction(
  body: TestChatMessagesStateActionBody,
): Promise<TestChatMessagesStateActionResponse> {
  const response = await requestChatMessagesState(
    "/api/test/chat-messages-state/action",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(
      `chat messages state action ${body.action} failed with ${response.status}`,
    );
  }
  return (await response.json()) as TestChatMessagesStateActionResponse;
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
  let releaseGate = (): void => {};
  const promise = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  onTestFinished(() => {
    releaseGate();
  });
  return {
    wait: () => {
      return promise;
    },
    release: releaseGate,
  };
}

describe("CHAT-02: completed chat callback", () => {
  it("persists assistant output, reorders threads, titles the thread, recommends follow-ups, notifies, and auto-sends the queued template message", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const titlePrompts: string[] = [];
    const followupPrompts: string[] = [];
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    chatCallbacks.mockOpenRouterCompletions((body) => {
      const systemContent = body.messages[0]?.content ?? "";
      if (systemContent.includes("Generate a short, descriptive title")) {
        titlePrompts.push(body.messages[1]?.content ?? "");
        return "Debugging Node Apps";
      }
      if (
        systemContent.includes("Generate up to three concise follow-up prompts")
      ) {
        followupPrompts.push(body.messages[1]?.content ?? "");
        return JSON.stringify([
          { prompt: "Turn this into a checklist", kind: "talk" },
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
    await queueChatMessage(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "queued next turn",
      generationTemplate,
    });
    const beforeComplete = await chat.listThreadMessages(actor, first.threadId);
    const queued = userMessages(beforeComplete.messages).find((message) => {
      return message.content === "queued next turn";
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
          lifecycleMarkers(messages, first.runId, "completed").some(
            (message) => {
              return (message.recommendedFollowups?.length ?? 0) === 2;
            },
          )
        );
      },
    );
    expect(
      eventBackedContents(after.messages, first.runId).map((message) => {
        return message.content;
      }),
    ).toStrictEqual(["final answer"]);
    expect(
      eventBackedContents(after.messages, first.runId)[0],
    ).not.toHaveProperty("status");

    const marker = lifecycleMarkers(
      after.messages,
      first.runId,
      "completed",
    )[0];
    if (!marker) {
      throw new Error("Expected a completed lifecycle marker");
    }
    expect(marker.content).toBeNull();
    expect(marker).not.toHaveProperty("status");
    expect(marker.recommendedFollowups).toStrictEqual([
      { prompt: "Turn this into a checklist", kind: "talk" },
      {
        prompt: "Generate a landing page for this plan",
        kind: "generate",
        generationType: "website",
      },
    ]);
    expect(followupPrompts).toHaveLength(1);
    expect(followupPrompts[0]).toContain("final answer");
    expect(followupPrompts[0]).not.toContain("queued next turn");
    await expect
      .poll(() => {
        return publishedChatThreadRunFinished(first.threadId);
      })
      .toBe(true);

    const recommender = assistantMessages(after.messages).find((message) => {
      return (
        message.runId === first.runId &&
        message.runLifecycleEvent === undefined &&
        (message.recommendedFollowups?.length ?? 0) > 0
      );
    });
    expect(recommender).toBeUndefined();

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

    const threads = await chat.listThreads(actor, { agentId });
    const orderedIds = [...threads.pinned, ...threads.threads].map((thread) => {
      return thread.id;
    });
    expect(orderedIds.indexOf(first.threadId)).toBeGreaterThanOrEqual(0);
    expect(orderedIds.indexOf(sentinel.threadId)).toBeGreaterThan(
      orderedIds.indexOf(first.threadId),
    );

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
            message.content === "queued next turn" &&
            message.runId !== undefined
          );
        });
      },
    );
    const claimed = userMessages(afterAutoSend.messages).find((message) => {
      return (
        message.content === "queued next turn" && message.runId !== undefined
      );
    });
    if (!claimed?.runId) {
      throw new Error("Expected the queued message to be auto-claimed");
    }
    expect(claimed.runId).not.toBe(first.runId);
    expect(claimed.revokesMessageId).toBe(queued.id);
    expect(claimed.generationTemplate).toStrictEqual(generationTemplate);
    // The paged-messages API returns the revoked original next to the
    // claiming copy; clients collapse the pair through revokesMessageId.
    expect(
      userMessages(afterAutoSend.messages)
        .filter((message) => {
          return message.content === "queued next turn";
        })
        .map((message) => {
          return message.id;
        })
        .sort(),
    ).toStrictEqual([queued.id, claimed.id].sort());
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
    expect(appended).toContain("- Artifact type: presentation");
    expect(appended).toContain(`(${template.designSystemId})`);
    expect(appended).toContain(`(${template.templateId})`);
    expect(appended).toContain("--artifact-kind presentation-html");
    expect(Object.keys(autoContext.body.environment)).toContain(
      "ANTHROPIC_API_KEY",
    );

    await api.requestCancelRun(actor, claimed.runId, [200]);
    await waitForRunStatus(actor, claimed.runId, "cancelled");
  }, 90_000);

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

    const queuedBeforeComplete = await chat.listThreadMessages(
      actor,
      first.threadId,
    );
    const queued = userMessages(queuedBeforeComplete.messages).find(
      (message) => {
        return message.content === "queued while side effects wait";
      },
    );
    if (!queued) {
      throw new Error("Expected the queued user message to be listed");
    }

    const openRouterGate = deferredGate();
    const titlePrompts: string[] = [];
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    chatCallbacks.mockOpenRouterCompletions(async (body) => {
      await openRouterGate.wait();
      const systemContent = body.messages[0]?.content ?? "";
      if (
        systemContent.includes("Generate up to three concise follow-up prompts")
      ) {
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
            message.revokesMessageId === queued.id &&
            message.runId !== undefined
          );
        });
      },
    );
    const markerBeforeRelease = lifecycleMarkers(
      afterAutoSend.messages,
      first.runId,
      "completed",
    )[0];
    if (!markerBeforeRelease) {
      throw new Error(
        "Expected completed marker before releasing side effects",
      );
    }
    expect(markerBeforeRelease.recommendedFollowups).toBeUndefined();

    const claimed = userMessages(afterAutoSend.messages).find((message) => {
      return message.revokesMessageId === queued.id;
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
      "api_dispatch_pre_create_zero_chat_callback_auto_send_claim_message",
      "api_dispatch_pre_create_zero_chat_callback_auto_send_publish_signals",
    ]);

    openRouterGate.release();
    const afterFollowups = await waitForThreadMessages(
      actor,
      first.threadId,
      (messages) => {
        return lifecycleMarkers(messages, first.runId, "completed").some(
          (message) => {
            return (
              message.id === markerBeforeRelease.id &&
              (message.recommendedFollowups?.length ?? 0) === 1
            );
          },
        );
      },
    );
    expect(
      lifecycleMarkers(afterFollowups.messages, first.runId, "completed"),
    ).toHaveLength(1);
    const markerAfterRelease = lifecycleMarkers(
      afterFollowups.messages,
      first.runId,
      "completed",
    )[0];
    expect(markerAfterRelease?.id).toBe(markerBeforeRelease.id);
    expect(markerAfterRelease?.recommendedFollowups).toStrictEqual([
      { prompt: "Review the queued result", kind: "talk" },
    ]);
    expect(titlePrompts).toHaveLength(1);
    expect(titlePrompts[0]).toContain("finish the current turn");
    expect(titlePrompts[0]).not.toContain("queued while side effects wait");

    await flushWaitUntilForTest();

    await queueChatMessage(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "queued after duplicate callback",
    });
    const afterSecondQueue = await chat.listThreadMessages(
      actor,
      first.threadId,
    );
    const duplicateProbeQueued = userMessages(afterSecondQueue.messages).find(
      (message) => {
        return message.content === "queued after duplicate callback";
      },
    );
    if (!duplicateProbeQueued) {
      throw new Error("Expected the duplicate probe message to queue");
    }

    await completeChatRunOk(first.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();

    const afterDuplicateCallback = await chat.listThreadMessages(
      actor,
      first.threadId,
    );
    const duplicateProbeClaimed = userMessages(
      afterDuplicateCallback.messages,
    ).filter((message) => {
      return message.revokesMessageId === duplicateProbeQueued.id;
    });
    expect(duplicateProbeClaimed).toHaveLength(0);
    const duplicateProbeStillQueued = userMessages(
      afterDuplicateCallback.messages,
    ).find((message) => {
      return message.id === duplicateProbeQueued.id;
    });
    expect(duplicateProbeStillQueued?.runId).toBeUndefined();

    await api.requestCancelRun(actor, claimed.runId, [200]);
    await waitForRunStatus(actor, claimed.runId, "cancelled");
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
    const queuedBeforeComplete = await chat.listThreadMessages(
      actor,
      first.threadId,
    );
    const queued = userMessages(queuedBeforeComplete.messages).find(
      (message) => {
        return message.content === "queued while org cap is full";
      },
    );
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
            message.revokesMessageId === queued.id &&
            message.runId !== undefined
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
    const claimed = userMessages(afterAutoSend.messages).find((message) => {
      return message.revokesMessageId === queued.id;
    });
    if (!claimed?.runId) {
      throw new Error("Expected the queued message to auto-send");
    }
    const marker = assistantMessages(afterAutoSend.messages).find((message) => {
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

  it("excludes pre-dispatch cancelled rows without chat messages from later context", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await startChatRun(actor, {
      agentId,
      prompt: "anchor before ghost",
    });
    const firstHeaders = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([assistantEvent(0, "anchor answer")]);
    await completeChatRunOk(first.runId, firstHeaders, {
      lastEventSequence: 0,
    });
    await waitForThreadMessages(actor, first.threadId, (messages) => {
      return assistantMessages(messages).some((message) => {
        return (
          message.runId === first.runId && message.content === "anchor answer"
        );
      });
    });

    const ghost = await api.createRun(actor, {
      agentId,
      prompt: "ghost pre-dispatch queued prompt",
      modelProvider: "anthropic-api-key",
    });
    await api.requestCancelRun(actor, ghost.runId, [200]);
    await waitForRunStatus(actor, ghost.runId, "cancelled");
    await postChatMessagesStateAction({
      action: "attach-pre-dispatch-cancelled-run-to-thread",
      run_id: ghost.runId,
      thread_id: first.threadId,
    });

    const second = await startChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue after ghost",
    });
    const secondRun = await api.readRun(actor, second.runId);
    const appended = secondRun.appendSystemPrompt ?? "";
    expect(appended).toContain("# Web Chat Run Context");
    expect(appended).toContain(`- RUN_ID: ${first.runId}`);
    expect(appended).toContain("User: anchor before ghost");
    expect(appended).toContain("Assistant: anchor answer");
    expect(appended).not.toContain(`- RUN_ID: ${ghost.runId}`);
    expect(appended).not.toContain("ghost pre-dispatch queued prompt");

    await api.requestCancelRun(actor, second.runId, [200]);
    await waitForRunStatus(actor, second.runId, "cancelled");
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
            message.content === "queued after streamed output" &&
            message.runId !== undefined
          );
        });
      },
    );
    expect(chatOutputAxiomQueryCalls()).toHaveLength(0);
    expect(
      eventBackedContents(messages.messages, first.runId).map((message) => {
        return message.content;
      }),
    ).toStrictEqual(["DB-complete streamed answer"]);
    expect(
      lifecycleMarkers(messages.messages, first.runId, "completed"),
    ).toHaveLength(1);

    const claimed = userMessages(messages.messages).find((message) => {
      return (
        message.content === "queued after streamed output" &&
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
        "api_dispatch_pre_create_zero_chat_callback_auto_send_claim_message",
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
      eventBackedContents(messages.messages, run.runId).map((message) => {
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
    expect(eventBackedContents(messages.messages, silent.runId)).toHaveLength(
      0,
    );

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
      eventBackedContents(messages.messages, resultOnly.runId).map(
        (message) => {
          return message.content;
        },
      ),
    ).toStrictEqual(["Axiom result fallback answer"]);
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
          return (
            call[0] === `chatThreadMessageCreated:${first.threadId}` &&
            call[1] === null
          );
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
    expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
      `chatThreadMessageCreated:${first.threadId}`,
      null,
    );
    const progressMessages = await chat.listThreadMessages(
      actor,
      first.threadId,
    );
    expect(progressMessages.messages).toHaveLength(1);
    expect(progressMessages.messages[0]?.role).toBe("user");

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
      eventBackedContents(messages.messages, first.runId).map((message) => {
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
      eventBackedContents(messages.messages, second.runId).map((message) => {
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
      eventBackedContents(messages.messages, third.runId).map((message) => {
        return message.content;
      }),
    ).toStrictEqual(["Already streamed."]);

    const beforeTitle = (await chat.readThread(actor, first.threadId)).title;
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
      lifecycleMarkers(messages.messages, fourth.runId, "completed"),
    ).toHaveLength(1);
    expect((await chat.readThread(actor, first.threadId)).title).toBe(
      beforeTitle,
    );
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
      await expect
        .poll(() => {
          return context.mocks.ably.publish.mock.calls.some((call) => {
            return (
              call[0] === `chatThreadRunCreated:${run.threadId}` &&
              call[1] === null
            );
          });
        })
        .toBe(true);
      context.mocks.ably.publish.mockClear();
      await failChatRun(run.runId, sandboxHeaders, round.error);
      expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
        `chatThreadRunCreated:${threadId}`,
        null,
      );
      await expect
        .poll(() => {
          return publishedChatThreadRunFinished(run.threadId);
        })
        .toBe(true);
    }
    const reportRunId = runIds[2];
    if (!threadId || !reportRunId) {
      throw new Error("Expected four failed chat rounds");
    }

    const messages = await waitForThreadMessages(actor, threadId, (items) => {
      const failed = assistantMessages(items).filter((message) => {
        return message.runLifecycleEvent === "failed";
      });
      return runIds.every((runId) => {
        return failed.some((message) => {
          return message.runId === runId && message.error !== undefined;
        });
      });
    });
    expect(userMessages(messages.messages)).toHaveLength(4);
    const failed = assistantMessages(messages.messages).filter((message) => {
      return message.runLifecycleEvent === "failed";
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

    await expect
      .poll(() => {
        return context.mocks.webpush.sendNotification.mock.calls.length;
      })
      .toBe(4);
    expect(
      pushPayload(context.mocks.webpush.sendNotification.mock.calls[1]),
    ).toMatchObject({
      title: "round two",
      body: "Task failed: Oops, something went wrong. Please try again later.",
      url: `/chats/${threadId}`,
    });
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
      const marker = lifecycleMarkers(page.messages, run.runId, "failed")[0];
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
      "Claude Code could not authenticate with the configured Anthropic API key. Update or replace the API key in Model Providers, then retry.\n\nOpen Model Providers: http://localhost:3002/?settings=providers",
    );
    await expect(
      failAndReadError({
        prompt: "org key failed for member",
        orgRole: "member",
      }),
    ).resolves.toBe(
      "Claude Code could not authenticate with the configured Anthropic API key. Ask a workspace admin to update or replace the API key.\n\nShare with an admin: http://localhost:3002/?settings=providers",
    );
  }, 90_000);
});

describe("CHAT-02: auto-send after failures", () => {
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
            message.content === "queued with files" &&
            message.runId !== undefined
          );
        });
      },
    );
    const claimed = userMessages(messages.messages).find((message) => {
      return (
        message.content === "queued with files" && message.runId !== undefined
      );
    });
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
        "api_dispatch_pre_create_zero_chat_callback_auto_send_resolve_attachments",
        "api_dispatch_pre_create_zero_chat_callback_auto_send_create_run",
        "api_dispatch_pre_create_zero_chat_callback_auto_send_claim_message",
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
    expect(appended).toContain(`[Web file]\n   [ID] ${contextFile.id}`);
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
    const afterFailureSecondQueue = await chat.listThreadMessages(
      actor,
      first.threadId,
    );
    const duplicateFailureProbeQueued = userMessages(
      afterFailureSecondQueue.messages,
    ).find((message) => {
      return message.content === "queued after duplicate failed callback";
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
    const afterDuplicateFailure = await chat.listThreadMessages(
      actor,
      first.threadId,
    );
    const duplicateFailureProbeClaimed = userMessages(
      afterDuplicateFailure.messages,
    ).filter((message) => {
      return message.revokesMessageId === duplicateFailureProbeQueued.id;
    });
    expect(duplicateFailureProbeClaimed).toHaveLength(0);
    const duplicateFailureProbeStillQueued = userMessages(
      afterDuplicateFailure.messages,
    ).find((message) => {
      return message.id === duplicateFailureProbeQueued.id;
    });
    expect(duplicateFailureProbeStillQueued?.runId).toBeUndefined();

    await api.requestCancelRun(actor, claimed.runId, [200]);
    await waitForRunStatus(actor, claimed.runId, "cancelled");
  }, 90_000);
});

describe("CHAT-02: auto-send across a model switch", () => {
  it("starts a fresh session with prior web context when the queued model differs, without regenerating an existing title", async () => {
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
    await chat.updateThreadModelSelection(actor, first.threadId, {
      modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
      selectedModel: "claude-sonnet-4-6",
    });
    await queueChatMessage(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "queued after model switch",
    });
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
            message.content === "queued after model switch" &&
            message.runId !== undefined
          );
        });
      },
    );
    const claimed = userMessages(messages.messages).find((message) => {
      return (
        message.content === "queued after model switch" &&
        message.runId !== undefined
      );
    });
    if (!claimed?.runId) {
      throw new Error(
        "Expected the queued message to be auto-claimed after the model switch",
      );
    }

    const autoContext = await waitForRunContext(actor, claimed.runId);
    const appended = autoContext.body.appendSystemPrompt ?? "";
    expect(appended).toContain("# Web Chat Run Context");
    expect(appended).toContain(`- RUN_ID: ${second.runId}`);
    expect(appended).toContain(
      `- LOG_COMMAND: zero logs ${second.runId} --all`,
    );
    expect(appended).toContain("User: And stringify?");
    expect(appended).toContain("Assistant: Use JSON.stringify(value).");
    expect(appended).toContain("...[truncated]");
    expect(appended).not.toContain("# Incomplete Rounds Context");
    // Fresh session: the queued model pin differs from the completed run's
    // model, so the auto-send run resumes no CLI session.
    expect(autoContext.body.sessionId).toBeNull();
    expect(Object.keys(autoContext.body.environment)).toContain(
      "ANTHROPIC_API_KEY",
    );

    const thread = await chat.readThread(actor, first.threadId);
    expect(thread.selectedModel).toBe("claude-sonnet-4-6");
    expect(thread.title).toBe("Working with JSON");

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
    expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
      `chatThreadMessageCreated:${run.threadId}`,
      null,
    );
    const deletedRead = await chat.requestReadThread(
      actor,
      run.threadId,
      [404],
    );
    expect(deletedRead.status).toBe(404);
  }, 60_000);
});

describe("CHAT-02: push notification gating", () => {
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
    expect(eventBackedContents(messages.messages, first.runId)).toHaveLength(0);
    expect(
      lifecycleMarkers(messages.messages, first.runId, "completed"),
    ).toHaveLength(1);
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
