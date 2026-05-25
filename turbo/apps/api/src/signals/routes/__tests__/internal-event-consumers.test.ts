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

describe("POST /api/internal/event-consumers/axiom", () => {
  it("rejects invalid signatures", async () => {
    const response = await postEventConsumer(
      AXIOM_PATH,
      { runId: "run-id", events: [], context: { userId: "u", orgId: "o" } },
      "wrong-key",
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Invalid signature");
  });

  it("ingests and flushes agent run events", async () => {
    const response = await postEventConsumer(AXIOM_PATH, {
      runId: "run_123",
      events: [
        { type: "assistant", sequenceNumber: 1, message: { content: [] } },
        { type: "tool_result", sequenceNumber: 2, result: "ok" },
      ],
      context: { userId: "user_123", orgId: "org_123" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ received: 2 });
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
  });

  it("returns 503 when Axiom ingest is not configured", async () => {
    context.mocks.axiom.ingest.mockReturnValue(false);

    const response = await postEventConsumer(AXIOM_PATH, {
      runId: "run_123",
      events: [{ type: "assistant", sequenceNumber: 1 }],
      context: { userId: "user_123", orgId: "org_123" },
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Axiom agent-run-events dataset is not configured",
    });
    expect(context.mocks.axiom.flush).not.toHaveBeenCalled();
  });

  it("returns 503 when Axiom flush fails", async () => {
    context.mocks.axiom.flush.mockRejectedValue(new Error("flush failed"));

    const response = await postEventConsumer(AXIOM_PATH, {
      runId: "run_123",
      events: [{ type: "assistant", sequenceNumber: 1 }],
      context: { userId: "user_123", orgId: "org_123" },
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Axiom agent-run-events flush failed",
    });
  });
});

describe("POST /api/internal/event-consumers/chat-assistant", () => {
  it("rejects invalid signatures", async () => {
    const response = await postEventConsumer(
      CHAT_ASSISTANT_PATH,
      { runId: "run-id", events: [], context: { userId: "u", orgId: "o" } },
      "wrong-key",
    );

    expect(response.status).toBe(401);
  });

  it("returns zero when no events contain assistant text", async () => {
    const fixture = await seedChatThreadRun();

    const response = await postEventConsumer(CHAT_ASSISTANT_PATH, {
      runId: fixture.runId,
      events: [buildToolUseEvent(1)],
      context: { userId: fixture.userId, orgId: fixture.orgId },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ processed: 0 });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("returns zero when the run is not tied to a chat thread", async () => {
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

    const response = await postEventConsumer(CHAT_ASSISTANT_PATH, {
      runId,
      events: [buildAssistantEvent(1, "Hello!")],
      context: { userId: fixture.userId, orgId: fixture.orgId },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ processed: 0 });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("persists Anthropic assistant text and publishes chat signals", async () => {
    const fixture = await seedChatThreadRun();

    const response = await postEventConsumer(CHAT_ASSISTANT_PATH, {
      runId: fixture.runId,
      events: [buildAssistantEvent(1, "Hello from the assistant!")],
      context: { userId: fixture.userId, orgId: fixture.orgId },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ processed: 1 });
    await expect(readAssistantMessages(fixture.runId)).resolves.toStrictEqual([
      {
        content: "Hello from the assistant!",
        sequenceNumber: 1,
        runEventId: "msg_1",
      },
    ]);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadMessageCreated:${fixture.threadId}`,
      null,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });

  it("persists Codex agent_message text from item.completed events", async () => {
    const fixture = await seedChatThreadRun();

    const response = await postEventConsumer(CHAT_ASSISTANT_PATH, {
      runId: fixture.runId,
      events: [buildCodexAgentMessageEvent(1, "Codex says hi")],
      context: { userId: fixture.userId, orgId: fixture.orgId },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ processed: 1 });
    await expect(readAssistantMessages(fixture.runId)).resolves.toStrictEqual([
      {
        content: "Codex says hi",
        sequenceNumber: 1,
        runEventId: "item_1",
      },
    ]);
  });

  it("ignores non-agent_message Codex item.completed events", async () => {
    const fixture = await seedChatThreadRun();

    const response = await postEventConsumer(CHAT_ASSISTANT_PATH, {
      runId: fixture.runId,
      events: [buildCodexCommandExecutionEvent(1)],
      context: { userId: fixture.userId, orgId: fixture.orgId },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ processed: 0 });
    await expect(readAssistantMessages(fixture.runId)).resolves.toStrictEqual(
      [],
    );
  });
});
