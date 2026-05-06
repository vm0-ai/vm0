import { describe, it, expect, beforeEach } from "vitest";
import { HttpResponse } from "msw";
import { POST } from "../route";
import {
  createTestCallback,
  createTestCompose,
  createSignedCallbackRequest,
  createTelegramCallbackInstallation,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { server } from "../../../../../../src/mocks/server";
import { http } from "../../../../../../src/__tests__/msw";
import { seedTestRun } from "../../../../../../src/__tests__/db-test-seeders/runs";

const SECRETS_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_BOT_TOKEN = "123456:ABC-test-telegram-typing";
const CONSUMER_URL =
  "http://localhost:3000/api/internal/event-consumers/telegram-typing";

const context = testContext();

function signed(body: unknown) {
  return createSignedCallbackRequest(
    CONSUMER_URL,
    body,
    SECRETS_ENCRYPTION_KEY,
  );
}

function telegramSendChatAction() {
  const calls: Array<{ chat_id: string; action: string }> = [];
  const handler = http.post(
    `https://api.telegram.org/bot${TEST_BOT_TOKEN}/sendChatAction`,
    async ({ request }) => {
      const body = (await request.json()) as {
        chat_id: string;
        action: string;
      };
      calls.push(body);
      return HttpResponse.json({ ok: true, result: true });
    },
  );
  return { ...handler, calls };
}

describe("POST /api/internal/event-consumers/telegram-typing", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("rejects invalid signatures", async () => {
    const request = createSignedCallbackRequest(
      CONSUMER_URL,
      { runId: "r", events: [], context: {} },
      "wrong-key",
    );
    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it("refreshes typing for pending Telegram callbacks", async () => {
    const user = await context.setupUser();
    const { composeId } = await createTestCompose(uniqueId("tg-typing"));
    const { installationId, userLinkId } =
      await createTelegramCallbackInstallation(
        composeId,
        user.userId,
        TEST_BOT_TOKEN,
      );
    const { runId } = await seedTestRun(user.userId, composeId);

    await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/telegram",
      payload: {
        installationId,
        chatId: "chat-123",
        messageId: "msg-1",
        rootMessageId: null,
        userLinkId,
        agentId: composeId,
        existingSessionId: null,
        isDM: true,
      },
    });

    const sendChatAction = telegramSendChatAction();
    server.use(sendChatAction.handler);

    const response = await POST(
      signed({
        runId,
        events: [{ type: "assistant", sequenceNumber: 1 }],
        context: { userId: user.userId, orgId: user.orgId },
      }),
    );
    await context.mocks.flushAfter();

    expect(response.status).toBe(200);
    expect(sendChatAction.mocked).toHaveBeenCalledTimes(1);
    expect(sendChatAction.calls[0]).toEqual({
      chat_id: "chat-123",
      action: "typing",
    });
  });

  it("does nothing when the run has no Telegram callbacks", async () => {
    const user = await context.setupUser();
    const { composeId } = await createTestCompose(uniqueId("tg-typing-none"));
    const { runId } = await seedTestRun(user.userId, composeId);
    const sendChatAction = telegramSendChatAction();
    server.use(sendChatAction.handler);

    const response = await POST(
      signed({
        runId,
        events: [{ type: "tool_result", sequenceNumber: 1 }],
        context: { userId: user.userId, orgId: user.orgId },
      }),
    );
    await context.mocks.flushAfter();

    expect(response.status).toBe(200);
    expect(sendChatAction.mocked).not.toHaveBeenCalled();
  });
});
