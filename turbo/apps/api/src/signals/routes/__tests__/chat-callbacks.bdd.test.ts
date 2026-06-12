import { createHash } from "node:crypto";

import { WebPushError } from "web-push";
import { PRESENTATION_TEMPLATE_ITEMS } from "@vm0/core";
import type {
  AttachFile,
  GenerationTemplateRequest,
  PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";

import { mockOptionalEnv } from "../../../lib/env";
import { testContext } from "../../../__tests__/test-helpers";
import { MODEL_FIRST_SELECTION_PROVIDER_ID } from "../../services/zero-model-selection.service";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsSchedulesApi } from "./helpers/api-bdd-runs-schedules";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

/**
 * CHAT-02 / HOOK-01: signed chat run callbacks through real dispatch.
 *
 * Every signed callback in this file originates from the real dispatcher
 * (sandbox complete/cancel webhooks and the sandbox heartbeat route) and is
 * either proxied into the app or captured for verbatim replay — no
 * hand-signed bodies and no direct database fixtures.
 */

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsSchedulesApi(context);
const chat = createChatFilesBddApi(context);
const webhooks = createWebhookCallbackApi(context);
const chatCallbacks = createChatCallbacksApi(context);

const USER_ARTIFACTS_BUCKET = "test-user-artifacts";

type AssistantMessage = Extract<PagedChatMessage, { role: "assistant" }>;
type UserMessage = Extract<PagedChatMessage, { role: "user" }>;

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
  const claim = await api.claimRunnerJob(runId);
  return { authorization: `Bearer ${claim.sandboxToken}` };
}

async function waitForArrayLength<T>(
  items: readonly T[],
  length: number,
): Promise<void> {
  await expect
    .poll(() => {
      return items.length;
    })
    .toBe(length);
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

function pushPayload(call: readonly unknown[] | undefined): unknown {
  const raw = call?.[1];
  return JSON.parse(typeof raw === "string" ? raw : "{}");
}

describe("CHAT-02: completed chat callback", () => {
  it("persists assistant output, reorders threads, titles the thread, recommends follow-ups, notifies, and auto-sends the queued template message", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.proxyChatCallbackToApp();
    await chatCallbacks.enableChatRecommendedFollowups(actor);

    const titlePrompts: string[] = [];
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

    const threads = await chat.listThreads(actor);
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
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadMessageCreated:${first.threadId}`,
      null,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadRunCreated:${first.threadId}`,
      null,
    );

    const autoContext = await api.requestRunContext(
      actor,
      claimed.runId,
      [200],
    );
    if (autoContext.status !== 200) {
      throw new Error("Expected the auto-send run context to be readable");
    }
    expect(autoContext.body.prompt).toBe("queued next turn");
    const appended = autoContext.body.appendSystemPrompt ?? "";
    expect(appended).toContain(
      "# Current Integration\nYou are currently running inside: Web",
    );
    expect(appended).toContain("# Generation Template");
    expect(appended).toContain("Type: presentation");
    expect(appended).toContain(`Design system ID: ${template.designSystemId}`);
    expect(appended).toContain(`Template ID: ${template.templateId}`);
    expect(appended).toContain("--artifact-kind presentation-html");
    expect(Object.keys(autoContext.body.environment)).toContain(
      "ANTHROPIC_API_KEY",
    );

    await api.requestCancelRun(actor, claimed.runId, [200]);
    await waitForRunStatus(actor, claimed.runId, "cancelled");
  }, 90_000);
});

describe("CHAT-02: chat output extraction and progress callbacks", () => {
  it("extracts assistant output from Codex items and result fallbacks, skips non-events, and acknowledges progress without reading events", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const deliveries = chatCallbacks.proxyChatCallbackToApp();

    const first = await startChatRun(actor, {
      agentId,
      prompt: "progress probe",
    });
    const firstHeaders = await claimChatRun(runnerGroup, first.runId);
    context.mocks.axiom.query.mockClear();
    context.mocks.ably.publish.mockClear();
    await webhooks.requestAgentHeartbeat(
      { runId: first.runId },
      firstHeaders,
      [200],
    );

    await waitForArrayLength(deliveries, 1);
    const progressBody: unknown = JSON.parse(deliveries[0]?.body ?? "{}");
    expect(progressBody).toMatchObject({
      callbackId: expect.stringMatching(/[0-9a-f-]{36}/),
      runId: first.runId,
      status: "progress",
      payload: { threadId: first.threadId, agentId },
    });
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

    // Blank assistant text and non-agent_message Codex items are skipped;
    // the LAST result event wins, including one whose sequence number only
    // exists inside eventData.
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, ""),
      {
        eventType: "item.completed",
        sequenceNumber: 1,
        eventData: { item: { type: "tool_call", text: "internal tool text" } },
      },
      {
        eventType: "result",
        eventData: { sequenceNumber: 2, result: "draft answer" },
      },
      resultEvent(3, "final fallback answer"),
    ]);
    await completeChatRunOk(first.runId, firstHeaders, {
      lastEventSequence: 1,
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

describe("CHAT-02/HOOK-01: chat callback replay and signature handling", () => {
  it("deduplicates concurrent and replayed deliveries and rejects tampered signatures", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const deliveries = chatCallbacks.captureChatCallbackDeliveries();

    const first = await startChatRun(actor, { agentId, prompt: "dedupe me" });
    const firstHeaders = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "First event"),
      assistantEvent(1, "Second event"),
    ]);
    await completeChatRunOk(first.runId, firstHeaders, {
      lastEventSequence: 1,
    });

    await waitForArrayLength(deliveries, 1);
    const completedDelivery = deliveries[0];
    if (!completedDelivery) {
      throw new Error("Expected a captured completed delivery");
    }
    const completedBody: unknown = JSON.parse(completedDelivery.body);
    expect(completedBody).toMatchObject({
      callbackId: expect.stringMatching(/[0-9a-f-]{36}/),
      runId: first.runId,
      status: "completed",
      payload: { threadId: first.threadId, agentId },
    });
    expect(completedDelivery.headers["x-vm0-signature"]).toMatch(/.+/);
    expect(completedDelivery.headers["x-vm0-timestamp"]).toMatch(/^\d+$/);

    const beforeReplay = await chat.listThreadMessages(actor, first.threadId);
    expect(assistantMessages(beforeReplay.messages)).toHaveLength(0);

    const [replayA, replayB] = await Promise.all([
      chatCallbacks.replayChatCallback(completedDelivery),
      chatCallbacks.replayChatCallback(completedDelivery),
    ]);
    expect(replayA.status).toBe(200);
    expect(replayB.status).toBe(200);
    let messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (threadMessages) => {
        return (
          eventBackedContents(threadMessages, first.runId).length === 2 &&
          lifecycleMarkers(threadMessages, first.runId, "completed").length ===
            1
        );
      },
    );
    expect(
      eventBackedContents(messages.messages, first.runId)
        .map((message) => {
          return message.content;
        })
        .sort(),
    ).toStrictEqual(["First event", "Second event"]);
    expect(
      lifecycleMarkers(messages.messages, first.runId, "completed"),
    ).toHaveLength(1);

    const sentinel = await chat.createThread(actor, {
      agentId,
      title: "Replay ordering sentinel",
    });
    context.mocks.ably.publish.mockClear();
    const replayAgain =
      await chatCallbacks.replayChatCallback(completedDelivery);
    expect(replayAgain.status).toBe(200);
    messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (threadMessages) => {
        return (
          lifecycleMarkers(threadMessages, first.runId, "completed").length ===
          1
        );
      },
    );
    expect(
      lifecycleMarkers(messages.messages, first.runId, "completed"),
    ).toHaveLength(1);
    expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
      `chatThreadMessageCreated:${first.threadId}`,
      null,
    );
    const ordered = await chat.listThreads(actor);
    const orderedIds = [...ordered.pinned, ...ordered.threads].map((thread) => {
      return thread.id;
    });
    expect(orderedIds.indexOf(sentinel.id)).toBeGreaterThanOrEqual(0);
    expect(orderedIds.indexOf(sentinel.id)).toBeLessThan(
      orderedIds.indexOf(first.threadId),
    );

    const tampered = await chatCallbacks.replayChatCallback(completedDelivery, {
      signature: chatCallbacks.tamperedSignature(completedDelivery),
    });
    expect(tampered.status).toBe(401);
    messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (threadMessages) => {
        return eventBackedContents(threadMessages, first.runId).length === 2;
      },
    );
    expect(eventBackedContents(messages.messages, first.runId)).toHaveLength(2);

    const second = await startChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "failed turn",
    });
    const secondHeaders = await claimChatRun(runnerGroup, second.runId);
    await failChatRun(
      second.runId,
      secondHeaders,
      "Cannot continue session from checkpoint",
    );

    await waitForArrayLength(deliveries, 2);
    const failedDelivery = deliveries[1];
    if (!failedDelivery) {
      throw new Error("Expected a captured failed delivery");
    }
    const failedBody: unknown = JSON.parse(failedDelivery.body);
    expect(failedBody).toMatchObject({
      runId: second.runId,
      status: "failed",
      error: "Cannot continue session from checkpoint",
      payload: { threadId: first.threadId, agentId },
    });

    const firstFailedReplay =
      await chatCallbacks.replayChatCallback(failedDelivery);
    expect(firstFailedReplay.status).toBe(200);
    await waitForThreadMessages(actor, first.threadId, (threadMessages) => {
      return (
        lifecycleMarkers(threadMessages, second.runId, "failed").length === 1
      );
    });
    context.mocks.ably.publish.mockClear();
    const secondFailedReplay =
      await chatCallbacks.replayChatCallback(failedDelivery);
    expect(secondFailedReplay.status).toBe(200);
    messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (threadMessages) => {
        return (
          lifecycleMarkers(threadMessages, second.runId, "failed").length === 1
        );
      },
    );
    const failedMarkers = lifecycleMarkers(
      messages.messages,
      second.runId,
      "failed",
    );
    expect(failedMarkers).toHaveLength(1);
    expect(failedMarkers[0]?.error).toBe(
      "Cannot continue session from checkpoint",
    );
    expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
      `chatThreadMessageCreated:${first.threadId}`,
      null,
    );
  }, 90_000);
});

describe("CHAT-02: failed chat callbacks", () => {
  it("formats failed-run errors with escalation and notifies, without auto-sending", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.proxyChatCallbackToApp();
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
      context.mocks.ably.publish.mockClear();
      await failChatRun(run.runId, sandboxHeaders, round.error);
      expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
        `chatThreadRunCreated:${threadId}`,
        null,
      );
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
});

describe("CHAT-02: auto-send after failures", () => {
  it("auto-sends the queued message after a failure, carrying attachments, incomplete-round context, and the continued session", async () => {
    const { actor, agentId, runnerGroup, storage } = await entitledChatActor();
    chatCallbacks.proxyChatCallbackToApp();

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
    expect(claimed.attachFiles).toHaveLength(1);
    expect(claimed.attachFiles?.[0]).toMatchObject({
      filename: "queued-notes.txt",
      url: expect.stringContaining(queuedFile.id),
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadRunCreated:${first.threadId}`,
      null,
    );

    const autoContext = await api.requestRunContext(
      actor,
      claimed.runId,
      [200],
    );
    if (autoContext.status !== 200) {
      throw new Error("Expected the auto-send run context to be readable");
    }
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

    await api.requestCancelRun(actor, claimed.runId, [200]);
    await waitForRunStatus(actor, claimed.runId, "cancelled");
  }, 90_000);
});

describe("CHAT-02: auto-send across a model switch", () => {
  it("starts a fresh session with prior web context when the queued model differs, without regenerating an existing title", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.proxyChatCallbackToApp();
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

    const autoContext = await api.requestRunContext(
      actor,
      claimed.runId,
      [200],
    );
    if (autoContext.status !== 200) {
      throw new Error("Expected the auto-send run context to be readable");
    }
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
    chatCallbacks.proxyChatCallbackToApp();

    const run = await startChatRun(actor, {
      agentId,
      prompt: "delete this thread",
    });
    await claimChatRun(runnerGroup, run.runId);

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
    chatCallbacks.proxyChatCallbackToApp();
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
