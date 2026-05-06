import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import {
  createTestCompose,
  insertTestChatThread,
  addTestRunToThread,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { createSignedCallbackRequest } from "../../../../../../src/__tests__/api-test-helpers/callbacks";
import { seedTestRun } from "../../../../../../src/__tests__/db-test-seeders/runs";
import { mockAblyPublish } from "../../../../../../src/__tests__/ably-mock";

// SECRETS_ENCRYPTION_KEY as stubbed in setup.ts
const SECRETS_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const CONSUMER_URL =
  "http://localhost:3000/api/internal/event-consumers/chat-assistant";

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
      content: [{ type: "tool_use", id: "tool_123", name: "bash", input: {} }],
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

const context = testContext();

describe("POST /api/internal/event-consumers/chat-assistant", () => {
  let user: UserContext;
  let agentComposeId: string;

  beforeEach(async () => {
    mockAblyPublish.mockClear();
    context.setupMocks();
    user = await context.setupUser();
    const compose = await createTestCompose(uniqueId("chat-assistant"));
    agentComposeId = compose.composeId;
  });

  function createEventConsumerRequest(body: unknown) {
    return createSignedCallbackRequest(
      CONSUMER_URL,
      body,
      SECRETS_ENCRYPTION_KEY,
    );
  }

  it("should return 401 for requests with invalid signature", async () => {
    const request = createSignedCallbackRequest(
      CONSUMER_URL,
      { runId: "some-run", events: [], context: {} },
      "wrong-key",
    );
    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it("should return 0 processed when no events contain text", async () => {
    const { runId } = await seedTestRun(user.userId, agentComposeId);
    const threadId = await insertTestChatThread(
      user.userId,
      agentComposeId,
      "test thread",
    );
    await addTestRunToThread(threadId, runId, user.userId);

    const request = createEventConsumerRequest({
      runId,
      events: [buildToolUseEvent(1)],
      context: { userId: user.userId, orgId: user.orgId },
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.processed).toBe(0);

    expect(mockAblyPublish).not.toHaveBeenCalled();
  });

  it("should return 0 processed when run is not tied to a chat thread", async () => {
    const { runId } = await seedTestRun(user.userId, agentComposeId);

    const request = createEventConsumerRequest({
      runId,
      events: [buildAssistantEvent(1, "Hello!")],
      context: { userId: user.userId, orgId: user.orgId },
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.processed).toBe(0);

    expect(mockAblyPublish).not.toHaveBeenCalled();
  });

  it("should publish chatThreadMessageCreated signal when text events are written", async () => {
    const { runId } = await seedTestRun(user.userId, agentComposeId);
    const threadId = await insertTestChatThread(
      user.userId,
      agentComposeId,
      "test thread",
    );
    await addTestRunToThread(threadId, runId, user.userId);

    const request = createEventConsumerRequest({
      runId,
      events: [buildAssistantEvent(1, "Hello from the assistant!")],
      context: { userId: user.userId, orgId: user.orgId },
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.processed).toBe(1);

    expect(mockAblyPublish).toHaveBeenCalledWith(
      `chatThreadMessageCreated:${threadId}`,
      null,
    );
  });

  it("should persist codex agent_message text from item.completed events", async () => {
    const { runId } = await seedTestRun(user.userId, agentComposeId);
    const threadId = await insertTestChatThread(
      user.userId,
      agentComposeId,
      "test thread",
    );
    await addTestRunToThread(threadId, runId, user.userId);

    const request = createEventConsumerRequest({
      runId,
      events: [buildCodexAgentMessageEvent(1, "Codex says hi")],
      context: { userId: user.userId, orgId: user.orgId },
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.processed).toBe(1);

    expect(mockAblyPublish).toHaveBeenCalledWith(
      `chatThreadMessageCreated:${threadId}`,
      null,
    );
  });

  it("should ignore non-agent_message codex item.completed events", async () => {
    const { runId } = await seedTestRun(user.userId, agentComposeId);
    const threadId = await insertTestChatThread(
      user.userId,
      agentComposeId,
      "test thread",
    );
    await addTestRunToThread(threadId, runId, user.userId);

    const request = createEventConsumerRequest({
      runId,
      events: [buildCodexCommandExecutionEvent(1)],
      context: { userId: user.userId, orgId: user.orgId },
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.processed).toBe(0);

    expect(mockAblyPublish).not.toHaveBeenCalled();
  });
});
