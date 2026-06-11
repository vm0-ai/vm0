import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { chatMessages } from "@vm0/db/schema/chat-message";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { now } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import {
  addRunToThread$,
  deleteZeroChatThread$,
  seedZeroChatThread$,
  type ZeroChatThreadFixture,
} from "./helpers/zero-chat-threads";
import { createFixtureTracker } from "./helpers/zero-route-test";
import { seedRun$ } from "./helpers/zero-usage-insight";

// BDD migration of the legacy
// `internal-event-consumers.test.ts`. The 11 legacy
// `it()`s collapse into 3 BDD `it()`s: (1) axiom path
// chain (401 invalid signature → 200 ingests + flushes
// agent run events → 503 dataset not configured → 503
// flush fails), (2) chat-assistant auth + skip chain (401
// invalid signature → 200 no events with assistant text →
// 200 blank assistant text → 200 run not tied to chat
// thread), (3) chat-assistant persist chain (200 persists
// Anthropic assistant text + publishes chat signals → 200
// persists Codex agent_message text from item.completed →
// 200 ignores non-agent_message Codex items → 200 ignores
// blank Codex agent_message).
//
// Service-Level Exception: This test exercises the
// internal `event-consumers` webhook endpoints. The legacy
// test called the routes via `app.request(...)` with HMAC
// headers; we keep the same pattern because these routes
// are webhook-style and not exposed via ts-rest contracts.

const SECRETS_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const AXIOM_PATH = "/api/internal/event-consumers/axiom";
const CHAT_ASSISTANT_PATH = "/api/internal/event-consumers/chat-assistant";

const context = testContext();
const store = createStore();

const trackChatFixture = createFixtureTracker<ZeroChatThreadFixture>(
  (fixture) => {
    return store.set(deleteZeroChatThread$, fixture, context.signal);
  },
);

function signedHeaders(
  rawBody: string,
  secret: string = SECRETS_ENCRYPTION_KEY,
): Record<string, string> {
  const ts = Math.floor(now() / 1000);
  return {
    "X-VM0-Signature": computeHmacSignature(rawBody, secret, ts),
    "X-VM0-Timestamp": String(ts),
    "Content-Type": "application/json",
  };
}

function postEventConsumer(
  path: string,
  body: unknown,
  secret?: string,
): Promise<Response> {
  const app = createApp({ signal: context.signal });
  const rawBody = JSON.stringify(body);
  return Promise.resolve(
    app.request(path, {
      method: "POST",
      headers: signedHeaders(rawBody, secret),
      body: rawBody,
    }),
  );
}

function buildAssistantEvent(
  sequenceNumber: number,
  text: string,
): Record<string, unknown> {
  return {
    type: "assistant",
    sequenceNumber,
    message: {
      id: `msg_${sequenceNumber}`,
      content: [{ type: "text", text }],
    },
  };
}

function buildToolUseEvent(sequenceNumber: number): Record<string, unknown> {
  return {
    type: "assistant",
    sequenceNumber,
    message: {
      id: `msg_${sequenceNumber}`,
      content: [{ type: "tool_use", id: "tool_1", name: "bash", input: {} }],
    },
  };
}

function buildCodexAgentMessageEvent(
  sequenceNumber: number,
  text: string,
): Record<string, unknown> {
  return {
    type: "item.completed",
    sequenceNumber,
    item: {
      id: `item_${sequenceNumber}`,
      type: "agent_message",
      text,
    },
  };
}

function buildCodexCommandExecutionEvent(
  sequenceNumber: number,
): Record<string, unknown> {
  return {
    type: "item.completed",
    sequenceNumber,
    item: {
      id: `cmd_${sequenceNumber}`,
      type: "command_execution",
      command: "ls",
      exit_code: 0,
      output: "README.md",
    },
  };
}

async function seedChatThreadRun(): Promise<
  ZeroChatThreadFixture & { readonly runId: string }
> {
  const fixture = await trackChatFixture(
    store.set(seedZeroChatThread$, {}, context.signal),
  );
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      composeId: fixture.composeId,
    },
    context.signal,
  );
  await store.set(
    addRunToThread$,
    { threadId: fixture.threadId, runId },
    context.signal,
  );
  return { ...fixture, runId };
}

function readAssistantMessages(runId: string): Promise<
  readonly {
    readonly content: string | null;
    readonly sequenceNumber: number | null;
    readonly runEventId: string | null;
  }[]
> {
  const writeDb = store.set(writeDb$);
  return writeDb
    .select({
      content: chatMessages.content,
      sequenceNumber: chatMessages.sequenceNumber,
      runEventId: chatMessages.runEventId,
    })
    .from(chatMessages)
    .where(
      and(eq(chatMessages.runId, runId), eq(chatMessages.role, "assistant")),
    );
}

beforeEach(() => {
  context.mocks.ably.publish.mockResolvedValue(undefined);
  context.mocks.axiom.flush.mockResolvedValue(undefined);
  context.mocks.axiom.ingest.mockReturnValue(true);
});

describe("BDD POST /api/internal/event-consumers/axiom — ingest + failure chain", () => {
  it("gwt-wt-wt: 401 invalid signature → 200 ingests + flushes agent run events → 503 dataset not configured → 503 flush fails", async () => {
    // Given: an invalid HMAC secret.

    // When + Then: 401 — invalid signature.
    const invalidResponse = await postEventConsumer(
      AXIOM_PATH,
      { runId: "run-id", events: [], context: { userId: "u", orgId: "o" } },
      "wrong-key",
    );
    expect(invalidResponse.status).toBe(401);
    const invalidBody = (await invalidResponse.json()) as { error: string };
    expect(invalidBody.error).toContain("Invalid signature");

    // Given: a valid request with two agent run events.

    // When + Then: 200 — both events ingested and a flush
    // is triggered.
    const ingestResponse = await postEventConsumer(AXIOM_PATH, {
      runId: "run_123",
      events: [
        { type: "assistant", sequenceNumber: 1, message: { content: [] } },
        { type: "tool_result", sequenceNumber: 2, result: "ok" },
      ],
      context: { userId: "user_123", orgId: "org_123" },
    });
    expect(ingestResponse.status).toBe(200);
    await expect(ingestResponse.json()).resolves.toStrictEqual({
      received: 2,
    });
    expect(context.mocks.axiom.ingest).toHaveBeenCalledWith(
      "agent-run-events",
      [
        {
          runId: "run_123",
          userId: "user_123",
          sequenceNumber: 1,
          eventType: "assistant",
          eventData: {
            type: "assistant",
            sequenceNumber: 1,
            message: { content: [] },
          },
        },
        {
          runId: "run_123",
          userId: "user_123",
          sequenceNumber: 2,
          eventType: "tool_result",
          eventData: {
            type: "tool_result",
            sequenceNumber: 2,
            result: "ok",
          },
        },
      ],
    );
    expect(context.mocks.axiom.flush).toHaveBeenCalledWith({
      throwOnError: true,
      client: "sessions",
    });

    // Given: Axiom dataset is not configured.

    // When + Then: 503 — dataset not configured + flush
    // is not called.
    context.mocks.axiom.ingest.mockReturnValue(false);
    context.mocks.axiom.flush.mockClear();
    const unconfiguredResponse = await postEventConsumer(AXIOM_PATH, {
      runId: "run_123",
      events: [{ type: "assistant", sequenceNumber: 1 }],
      context: { userId: "user_123", orgId: "org_123" },
    });
    expect(unconfiguredResponse.status).toBe(503);
    await expect(unconfiguredResponse.json()).resolves.toStrictEqual({
      error: "Axiom agent-run-events dataset is not configured",
    });
    expect(context.mocks.axiom.flush).not.toHaveBeenCalled();

    // Given: Axiom flush fails.

    // When + Then: 503 — flush failure.
    context.mocks.axiom.ingest.mockReturnValue(true);
    context.mocks.axiom.flush.mockRejectedValue(new Error("flush failed"));
    const flushFailedResponse = await postEventConsumer(AXIOM_PATH, {
      runId: "run_123",
      events: [{ type: "assistant", sequenceNumber: 1 }],
      context: { userId: "user_123", orgId: "org_123" },
    });
    expect(flushFailedResponse.status).toBe(503);
    await expect(flushFailedResponse.json()).resolves.toStrictEqual({
      error: "Axiom agent-run-events flush failed",
    });
  });
});

describe("BDD POST /api/internal/event-consumers/chat-assistant — auth + skip chain", () => {
  it("gwt-wt-wt: 401 invalid signature → 200 no events with assistant text → 200 blank assistant text → 200 run not tied to chat thread", async () => {
    // Given: an invalid HMAC secret.

    // When + Then: 401.
    const invalidResponse = await postEventConsumer(
      CHAT_ASSISTANT_PATH,
      { runId: "run-id", events: [], context: { userId: "u", orgId: "o" } },
      "wrong-key",
    );
    expect(invalidResponse.status).toBe(401);

    // Given: a seeded chat thread + run + a tool_use event
    // (no assistant text).

    // When + Then: 200 — zero processed + ably not
    // published.
    const noTextFixture = await seedChatThreadRun();
    const noTextResponse = await postEventConsumer(CHAT_ASSISTANT_PATH, {
      runId: noTextFixture.runId,
      events: [buildToolUseEvent(1)],
      context: { userId: noTextFixture.userId, orgId: noTextFixture.orgId },
    });
    expect(noTextResponse.status).toBe(200);
    await expect(noTextResponse.json()).resolves.toStrictEqual({
      processed: 0,
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    // Given: a seeded chat thread + run + a blank
    // assistant text event.

    // When + Then: 200 — zero processed + no chat
    // messages persisted + ably not published.
    const blankFixture = await seedChatThreadRun();
    const blankResponse = await postEventConsumer(CHAT_ASSISTANT_PATH, {
      runId: blankFixture.runId,
      events: [buildAssistantEvent(1, "")],
      context: { userId: blankFixture.userId, orgId: blankFixture.orgId },
    });
    expect(blankResponse.status).toBe(200);
    await expect(blankResponse.json()).resolves.toStrictEqual({
      processed: 0,
    });
    await expect(
      readAssistantMessages(blankFixture.runId),
    ).resolves.toStrictEqual([]);
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    // Given: a run that is not tied to a chat thread.

    // When + Then: 200 — zero processed + ably not
    // published.
    const untiedFixture = await trackChatFixture(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    const { runId: untiedRunId } = await store.set(
      seedRun$,
      {
        orgId: untiedFixture.orgId,
        userId: untiedFixture.userId,
        composeId: untiedFixture.composeId,
      },
      context.signal,
    );

    const untiedResponse = await postEventConsumer(CHAT_ASSISTANT_PATH, {
      runId: untiedRunId,
      events: [buildAssistantEvent(1, "Hello!")],
      context: { userId: untiedFixture.userId, orgId: untiedFixture.orgId },
    });
    expect(untiedResponse.status).toBe(200);
    await expect(untiedResponse.json()).resolves.toStrictEqual({
      processed: 0,
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });
});

describe("BDD POST /api/internal/event-consumers/chat-assistant — persist chain", () => {
  it("gwt-wt-wt: 200 persists Anthropic assistant text + publishes chat signals → 200 persists Codex agent_message text from item.completed → 200 ignores non-agent_message Codex items → 200 ignores blank Codex agent_message", async () => {
    // Given: a seeded chat thread + run + an Anthropic
    // assistant text event.

    // When + Then: 200 — message persisted + ably
    // publishes chatThreadMessageCreated + threadListChanged.
    const anthropicFixture = await seedChatThreadRun();
    const anthropicResponse = await postEventConsumer(CHAT_ASSISTANT_PATH, {
      runId: anthropicFixture.runId,
      events: [buildAssistantEvent(1, "Hello from the assistant!")],
      context: {
        userId: anthropicFixture.userId,
        orgId: anthropicFixture.orgId,
      },
    });
    expect(anthropicResponse.status).toBe(200);
    await expect(anthropicResponse.json()).resolves.toStrictEqual({
      processed: 1,
    });
    await expect(
      readAssistantMessages(anthropicFixture.runId),
    ).resolves.toStrictEqual([
      {
        content: "Hello from the assistant!",
        sequenceNumber: 1,
        runEventId: "msg_1",
      },
    ]);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadMessageCreated:${anthropicFixture.threadId}`,
      null,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );

    // Given: a seeded chat thread + run + a Codex
    // agent_message item.completed event.

    // When + Then: 200 — message persisted with item id
    // as runEventId.
    const codexFixture = await seedChatThreadRun();
    const codexResponse = await postEventConsumer(CHAT_ASSISTANT_PATH, {
      runId: codexFixture.runId,
      events: [buildCodexAgentMessageEvent(1, "Codex says hi")],
      context: { userId: codexFixture.userId, orgId: codexFixture.orgId },
    });
    expect(codexResponse.status).toBe(200);
    await expect(codexResponse.json()).resolves.toStrictEqual({
      processed: 1,
    });
    await expect(
      readAssistantMessages(codexFixture.runId),
    ).resolves.toStrictEqual([
      {
        content: "Codex says hi",
        sequenceNumber: 1,
        runEventId: "item_1",
      },
    ]);

    // Given: a seeded chat thread + run + a non-
    // agent_message Codex item.completed event.

    // When + Then: 200 — zero processed + no messages
    // persisted.
    const nonAgentFixture = await seedChatThreadRun();
    const nonAgentResponse = await postEventConsumer(CHAT_ASSISTANT_PATH, {
      runId: nonAgentFixture.runId,
      events: [buildCodexCommandExecutionEvent(1)],
      context: { userId: nonAgentFixture.userId, orgId: nonAgentFixture.orgId },
    });
    expect(nonAgentResponse.status).toBe(200);
    await expect(nonAgentResponse.json()).resolves.toStrictEqual({
      processed: 0,
    });
    await expect(
      readAssistantMessages(nonAgentFixture.runId),
    ).resolves.toStrictEqual([]);

    // Given: a seeded chat thread + run + a blank Codex
    // agent_message item.completed event.

    // When + Then: 200 — zero processed + no messages
    // persisted.
    const blankCodexFixture = await seedChatThreadRun();
    const blankCodexResponse = await postEventConsumer(CHAT_ASSISTANT_PATH, {
      runId: blankCodexFixture.runId,
      events: [buildCodexAgentMessageEvent(1, "   ")],
      context: {
        userId: blankCodexFixture.userId,
        orgId: blankCodexFixture.orgId,
      },
    });
    expect(blankCodexResponse.status).toBe(200);
    await expect(blankCodexResponse.json()).resolves.toStrictEqual({
      processed: 0,
    });
    await expect(
      readAssistantMessages(blankCodexFixture.runId),
    ).resolves.toStrictEqual([]);
  });
});
