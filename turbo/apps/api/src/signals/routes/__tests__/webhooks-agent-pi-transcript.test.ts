import { randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import {
  webhookEventsContract,
  webhookPiTranscriptContract,
} from "@vm0/api-contracts/contracts/webhooks";
import { describe, expect, it } from "vitest";

import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { webhooksAgentEventsRoutes } from "../webhooks-agent-events";
import { webhooksAgentPiTranscriptRoutes } from "../webhooks-agent-pi-transcript";

/**
 * PI-01: pi.message.completed ingestion through the agent events webhook and
 * the pi-transcript read route.
 *
 * Every Given is constructed through public APIs (chat send creates the
 * thread-bound run, the sandbox token authenticates deliveries) and every
 * Then is a webhook response, transcript read, chat thread messages page,
 * Ably publish, or captured Axiom ingest body.
 */

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const webhooks = createWebhookCallbackApi(context);
const chatCallbacks = createChatCallbacksApi(context);

const PI_EVENT_TYPE = "pi.message.completed";

async function entitledChatActor(): Promise<{
  readonly actor: ApiTestUser;
  readonly agentId: string;
}> {
  const actor = bdd.user();
  chatCallbacks.acceptChatObjectStorage();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  chatCallbacks.disableVapid();
  api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Pi transcript agent",
    description: "Exercises pi.message.completed ingestion.",
    visibility: "private",
  });
  return { actor, agentId: agent.agentId };
}

async function chatRun(
  actor: ApiTestUser,
  agentId: string,
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const sent = await chat.requestSendEvent(
    actor,
    { agentId, prompt: "start a pi run", clientEventId: randomUUID() },
    [201],
  );
  if (sent.status !== 201) {
    throw new Error("Expected the chat send to create a run");
  }
  const runId = sent.body.runId;
  if (runId === null || runId === undefined) {
    throw new Error("Expected the chat send to dispatch a run inline");
  }
  return { runId, threadId: sent.body.threadId };
}

function assistantMessage(text: string): Record<string, unknown> {
  return {
    role: "assistant",
    content: [
      { type: "text", text },
      { type: "tool_call", id: "tool-1", name: "bash", arguments: {} },
    ],
  };
}

function toolCallOnlyMessage(): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "tool_call", id: "tool-1", name: "bash", arguments: {} }],
  };
}

function toolResultMessage(): Record<string, unknown> {
  return {
    role: "toolResult",
    content: [{ type: "tool_result", toolCallId: "tool-1", output: "ok" }],
  };
}

function piEvent(args: {
  readonly sequenceNumber: number;
  readonly messageId: string;
  readonly message?: Record<string, unknown>;
}): { type: string; sequenceNumber: number } & Record<string, unknown> {
  return {
    type: PI_EVENT_TYPE,
    sequenceNumber: args.sequenceNumber,
    messageId: args.messageId,
    message: args.message ?? assistantMessage("hello from pi"),
  };
}

function eventsClient() {
  return setupApp({ context, routes: webhooksAgentEventsRoutes })(
    webhookEventsContract,
  );
}

function transcriptClient() {
  return setupApp({ context, routes: webhooksAgentPiTranscriptRoutes })(
    webhookPiTranscriptContract,
  );
}

async function sendEvents(
  runId: string,
  events: readonly ({ type: string; sequenceNumber: number } & Record<
    string,
    unknown
  >)[],
  statuses: readonly (200 | 400 | 401 | 503)[],
) {
  return await accept(
    eventsClient().send({
      headers: webhooks.sandboxWebhookHeaders({ runId }),
      body: { runId, events: [...events] },
    }),
    statuses,
  );
}

async function readTranscript(
  runId: string,
  statuses: readonly (200 | 401 | 404)[],
  tokenRunId?: string,
  afterOrdinal = 0,
) {
  return await accept(
    transcriptClient().read({
      headers: webhooks.sandboxWebhookHeaders({
        runId,
        ...(tokenRunId === undefined ? {} : { tokenRunId }),
      }),
      query: { runId, afterOrdinal },
    }),
    statuses,
  );
}

async function readTranscriptOk(runId: string, afterOrdinal = 0) {
  const response = await readTranscript(runId, [200], undefined, afterOrdinal);
  if (response.status !== 200) {
    throw new Error("Expected the pi transcript read to succeed");
  }
  return response.body;
}

async function outputMessages(actor: ApiTestUser, threadId: string) {
  const page = await chat.listThreadEvents(actor, threadId);
  return page.events.filter((event) => {
    return event.eventType === "output.message";
  });
}

function publishedTopics(): readonly string[] {
  return context.mocks.ably.publish.mock.calls.map(([topic]) => {
    return topic as string;
  });
}

function topicCount(threadId: string): number {
  return publishedTopics().filter((topic) => {
    return topic === `chatThreadMessageCreated:${threadId}`;
  }).length;
}

describe("POST /api/webhooks/agent/events with pi.message.completed", () => {
  it("appends the transcript and projects assistant text in one delivery", async () => {
    const { actor, agentId } = await entitledChatActor();
    const { runId, threadId } = await chatRun(actor, agentId);

    const response = await sendEvents(
      runId,
      [
        piEvent({
          sequenceNumber: 1,
          messageId: "pi-m1",
          message: assistantMessage("first reply"),
        }),
        piEvent({
          sequenceNumber: 2,
          messageId: "pi-m2",
          message: toolResultMessage(),
        }),
      ],
      [200],
    );
    expect(response.body).toMatchObject({ received: 2 });

    const transcript = await readTranscriptOk(runId);
    expect(transcript.lastOrdinal).toBe(2);
    expect(transcript.hasMore).toBeFalsy();
    expect(transcript.messages).toHaveLength(2);
    expect(transcript.messages[0]).toMatchObject({
      ordinal: 1,
      messageId: "pi-m1",
      runId,
      runEventSequenceNumber: 1,
      role: "assistant",
      payload: assistantMessage("first reply"),
    });
    expect(transcript.messages[1]).toMatchObject({
      ordinal: 2,
      messageId: "pi-m2",
      role: "toolResult",
    });

    const projected = await outputMessages(actor, threadId);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      content: "first reply",
      runId,
    });

    await flushWaitUntilForTest();
    expect(publishedTopics()).toContain(`chatThreadMessageCreated:${threadId}`);
  });

  it("does not create a chat bubble for tool-call-only assistant messages", async () => {
    const { actor, agentId } = await entitledChatActor();
    const { runId, threadId } = await chatRun(actor, agentId);
    await flushWaitUntilForTest();
    const publishCountBefore = topicCount(threadId);

    await sendEvents(
      runId,
      [
        piEvent({
          sequenceNumber: 1,
          messageId: "pi-m1",
          message: toolCallOnlyMessage(),
        }),
        piEvent({
          sequenceNumber: 2,
          messageId: "pi-m2",
          message: toolResultMessage(),
        }),
      ],
      [200],
    );

    const transcript = await readTranscriptOk(runId);
    expect(transcript.lastOrdinal).toBe(2);
    await expect(outputMessages(actor, threadId)).resolves.toHaveLength(0);

    await flushWaitUntilForTest();
    expect(topicCount(threadId)).toBe(publishCountBefore);
  });

  it("rejects malformed pi events without opening a transcript", async () => {
    const { actor, agentId } = await entitledChatActor();
    const { runId } = await chatRun(actor, agentId);

    const response = await sendEvents(
      runId,
      [
        {
          type: PI_EVENT_TYPE,
          sequenceNumber: 1,
          message: assistantMessage("missing message id"),
        },
      ],
      [400],
    );
    expect(response.body).toMatchObject({ error: { code: "BAD_REQUEST" } });

    const transcript = await readTranscriptOk(runId);
    expect(transcript.messages).toHaveLength(0);
  });

  it("rejects pi events for a run without a chat thread", async () => {
    const { actor } = await entitledChatActor();
    const compose = await api.createCompose(actor, {
      version: "1.0",
      agents: {
        "pi-direct": {
          framework: "claude-code",
          environment: { ANTHROPIC_API_KEY: "pi-direct-test-key" },
        },
      },
    });
    const run = await api.createDirectRun(actor, {
      agentComposeId: compose.composeId,
      prompt: "direct run",
    });

    const rejected = await sendEvents(
      run.runId,
      [
        piEvent({
          sequenceNumber: 1,
          messageId: "pi-m1",
        }),
      ],
      [400],
    );
    expect(rejected.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    await readTranscript(run.runId, [404]);
  });

  it("keeps the canonical payload out of Axiom telemetry", async () => {
    const { actor, agentId } = await entitledChatActor();
    const { runId } = await chatRun(actor, agentId);
    mockEnv("AXIOM_TOKEN_SESSIONS", "axiom-bdd-token");
    mockEnv("AXIOM_TOKEN_TELEMETRY", "axiom-bdd-token");
    const ingested: Record<string, unknown>[][] = [];
    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/agent-run-events/ingest",
        async ({ request }) => {
          const events = (await request.json()) as Record<string, unknown>[];
          ingested.push(events);
          return HttpResponse.json({
            ingested: events.length,
            failed: 0,
            processedBytes: 0,
          });
        },
      ),
    );

    await sendEvents(
      runId,
      [
        piEvent({
          sequenceNumber: 1,
          messageId: "pi-m1",
          message: assistantMessage("secret transcript"),
        }),
      ],
      [200],
    );
    await flushWaitUntilForTest();

    const piIngest = ingested.flat().filter((event) => {
      return event.eventType === PI_EVENT_TYPE;
    });
    expect(piIngest).toHaveLength(1);
    const eventData = piIngest[0]?.eventData as Record<string, unknown>;
    expect(eventData.message).toBeUndefined();
    expect(eventData).toMatchObject({
      messageId: "pi-m1",
      role: "assistant",
    });
    expect(typeof eventData.payloadBytes).toBe("number");
    expect(JSON.stringify(ingested)).not.toContain("secret transcript");
  });
});

describe("GET /api/webhooks/agent/pi-transcript", () => {
  it("scopes reads to the run's own thread", async () => {
    const first = await entitledChatActor();
    const firstRun = await chatRun(first.actor, first.agentId);
    const second = await entitledChatActor();
    const secondRun = await chatRun(second.actor, second.agentId);

    await sendEvents(
      firstRun.runId,
      Array.from({ length: 11 }, (_, index) => {
        const sequenceNumber = index + 1;
        return piEvent({
          sequenceNumber,
          messageId: `pi-m${sequenceNumber}`,
          message: assistantMessage(`thread one message ${sequenceNumber}`),
        });
      }),
      [200],
    );

    const other = await readTranscriptOk(secondRun.runId);
    expect(other.messages).toHaveLength(0);

    const firstPage = await readTranscriptOk(firstRun.runId);
    expect(firstPage).toMatchObject({
      lastOrdinal: 10,
      hasMore: true,
    });
    expect(firstPage.messages).toHaveLength(10);

    const delta = await readTranscriptOk(firstRun.runId, 10);
    expect(delta).toMatchObject({
      lastOrdinal: 11,
      hasMore: false,
      messages: [{ ordinal: 11, messageId: "pi-m11" }],
    });

    await readTranscript(firstRun.runId, [401], secondRun.runId);
  });
});
