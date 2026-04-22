import { describe, it, expect, beforeEach } from "vitest";
import { HttpResponse } from "msw";
import { POST } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import {
  createTestCallback,
  createTestAgentSession,
  createTestRequest,
  createTestOrg,
  createTestCompose,
  createSignedCallbackRequest,
  createTelegramCallbackInstallation,
} from "../../../../../../src/__tests__/api-test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { server } from "../../../../../../src/mocks/server";
import { http } from "../../../../../../src/__tests__/msw";
import { seedTestRun } from "../../../../../../src/__tests__/db-test-seeders/runs";

const context = testContext();

const TEST_BOT_TOKEN = "123456:ABC-test-telegram-callback";

interface TelegramCallbackPayload {
  installationId: string;
  chatId: string;
  messageId: string;
  userLinkId: string;
  agentId: string;
  existingSessionId: string | null;
  isDM: boolean;
  thinkingMessageId: string | null;
}

function telegramSendMessage() {
  return http.post(
    `https://api.telegram.org/bot${TEST_BOT_TOKEN}/sendMessage`,
    () => {
      return HttpResponse.json({
        ok: true,
        result: { message_id: 999, chat: { id: 123 }, text: "response" },
      });
    },
  );
}

function telegramSendChatAction() {
  return http.post(
    `https://api.telegram.org/bot${TEST_BOT_TOKEN}/sendChatAction`,
    () => {
      return HttpResponse.json({ ok: true, result: true });
    },
  );
}

function telegramEditMessageText() {
  return http.post(
    `https://api.telegram.org/bot${TEST_BOT_TOKEN}/editMessageText`,
    () => {
      return HttpResponse.json({
        ok: true,
        result: { message_id: 100, chat: { id: 123 }, text: "edited" },
      });
    },
  );
}

function telegramDeleteMessage() {
  return http.post(
    `https://api.telegram.org/bot${TEST_BOT_TOKEN}/deleteMessage`,
    () => {
      return HttpResponse.json({ ok: true, result: true });
    },
  );
}

/**
 * Set up a full Telegram test context: org, compose (with version),
 * installation (encrypted token), user link, run, callback.
 */
async function setupTelegramCallback() {
  const userId = uniqueId("user");
  mockClerk({ userId });

  // Create org + compose (with version) through API
  await createTestOrg(uniqueId("org"));
  const { composeId } = await createTestCompose(uniqueId("telegram-agent"));

  // Create installation with encrypted bot token + user link via helper
  const { installationId, userLinkId } =
    await createTelegramCallbackInstallation(composeId, userId, TEST_BOT_TOKEN);

  // Create run and callback (direct DB insert — avoids full API resolution)
  const { runId } = await seedTestRun(userId, composeId, {
    prompt: "Test prompt",
  });
  const chatId = `chat-${Date.now()}`;
  const messageId = "42";

  const payload: TelegramCallbackPayload = {
    installationId,
    chatId,
    messageId,
    userLinkId,
    agentId: composeId,
    existingSessionId: null,
    isDM: false,
    thinkingMessageId: "100",
  };

  const { secret } = await createTestCallback({
    runId,
    url: "http://localhost/api/internal/callbacks/telegram",
    payload: { ...payload },
  });

  return {
    installationId,
    composeId,
    userId,
    userLinkId,
    runId,
    chatId,
    messageId,
    payload,
    secret,
  };
}

describe("POST /api/internal/callbacks/telegram", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("Signature Verification", () => {
    it("should reject request with invalid signature", async () => {
      const { runId, payload, secret } = await setupTelegramCallback();

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/telegram",
        { runId, status: "completed", payload },
        secret,
        { invalidSignature: true },
      );
      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toContain("signature");
    });

    it("should reject request with expired timestamp", async () => {
      const { runId, payload, secret } = await setupTelegramCallback();

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/telegram",
        { runId, status: "completed", payload },
        secret,
        { expiredTimestamp: true },
      );
      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toContain("expired");
    });

    it("should reject request for non-existent callback", async () => {
      const request = createTestRequest(
        "http://localhost/api/internal/callbacks/telegram",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-VM0-Signature": "any-signature",
            "X-VM0-Timestamp": Math.floor(Date.now() / 1000).toString(),
          },
          body: JSON.stringify({
            runId: "00000000-0000-0000-0000-000000000000",
            status: "completed",
            payload: {
              installationId: "inst-123",
              chatId: "123",
              messageId: "1",
              userLinkId: "link-123",
              agentId: "compose-123",
              existingSessionId: null,
            },
          }),
        },
      );
      const response = await POST(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toContain("not found");
    });
  });

  describe("Successful Callback", () => {
    it("should return 200 and send message on completed run", async () => {
      const { runId, payload, secret } = await setupTelegramCallback();

      const chatActionHandler = telegramSendChatAction();
      const deleteMessageHandler = telegramDeleteMessage();
      const sendMessageHandler = telegramSendMessage();
      server.use(
        chatActionHandler.handler,
        deleteMessageHandler.handler,
        sendMessageHandler.handler,
      );

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/telegram",
        { runId, status: "completed", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Telegram API was called
      expect(deleteMessageHandler.mocked).toHaveBeenCalledTimes(1);
      expect(sendMessageHandler.mocked).toHaveBeenCalledTimes(1);
    });

    it("should return 200 and send error message on failed run", async () => {
      const { runId, payload, secret } = await setupTelegramCallback();

      const chatActionHandler = telegramSendChatAction();
      const deleteMessageHandler = telegramDeleteMessage();
      const sendMessageHandler = telegramSendMessage();
      server.use(
        chatActionHandler.handler,
        deleteMessageHandler.handler,
        sendMessageHandler.handler,
      );

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/telegram",
        {
          runId,
          status: "failed",
          error: "Agent crashed unexpectedly",
          payload,
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      expect(sendMessageHandler.mocked).toHaveBeenCalledTimes(1);
    });
  });

  describe("Progress Callback", () => {
    it("should refresh typing indicator and return early without sending a message", async () => {
      const { runId, payload, secret } = await setupTelegramCallback();

      const chatActionHandler = telegramSendChatAction();
      const editHandler = telegramEditMessageText();
      const sendMessageHandler = telegramSendMessage();
      server.use(
        chatActionHandler.handler,
        editHandler.handler,
        sendMessageHandler.handler,
      );

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/telegram",
        { runId, status: "progress", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Should refresh typing indicator
      expect(chatActionHandler.mocked).toHaveBeenCalledTimes(1);
      // Should edit thinking message back to thinking state
      expect(editHandler.mocked).toHaveBeenCalledTimes(1);
      // Should NOT send a new message
      expect(sendMessageHandler.mocked).not.toHaveBeenCalled();
    });

    it("should skip editing when no thinkingMessageId is set", async () => {
      const { runId, payload, secret } = await setupTelegramCallback();

      const chatActionHandler = telegramSendChatAction();
      const editHandler = telegramEditMessageText();
      server.use(chatActionHandler.handler, editHandler.handler);

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/telegram",
        {
          runId,
          status: "progress",
          payload: { ...payload, thinkingMessageId: null },
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(chatActionHandler.mocked).toHaveBeenCalledTimes(1);
      expect(editHandler.mocked).not.toHaveBeenCalled();
    });
  });

  describe("Thread Session", () => {
    it("should process new thread callback without error", async () => {
      const { runId, payload, secret, userId, composeId } =
        await setupTelegramCallback();

      const chatActionHandler = telegramSendChatAction();
      const deleteMessageHandler = telegramDeleteMessage();
      const sendMessageHandler = telegramSendMessage();
      server.use(
        chatActionHandler.handler,
        deleteMessageHandler.handler,
        sendMessageHandler.handler,
      );

      // Create an agent session for findNewSessionId
      await createTestAgentSession(userId, composeId);

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/telegram",
        { runId, status: "completed", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
    });

    it("should process existing session callback without error", async () => {
      const { runId, payload, secret } = await setupTelegramCallback();

      const chatActionHandler = telegramSendChatAction();
      const deleteMessageHandler = telegramDeleteMessage();
      const sendMessageHandler = telegramSendMessage();
      server.use(
        chatActionHandler.handler,
        deleteMessageHandler.handler,
        sendMessageHandler.handler,
      );

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/telegram",
        {
          runId,
          status: "completed",
          payload: { ...payload, existingSessionId: "existing-session-id" },
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
    });
  });

  describe("Validation", () => {
    it("should reject request with missing runId", async () => {
      const request = createTestRequest(
        "http://localhost/api/internal/callbacks/telegram",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-VM0-Signature": "any-signature",
            "X-VM0-Timestamp": Math.floor(Date.now() / 1000).toString(),
          },
          body: JSON.stringify({
            status: "completed",
            payload: {
              installationId: "inst-123",
              chatId: "123",
              messageId: "1",
              userLinkId: "link-123",
              agentId: "compose-123",
              existingSessionId: null,
            },
          }),
        },
      );
      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain("runId");
    });

    it("should reject request with invalid payload", async () => {
      const { runId, secret } = await setupTelegramCallback();

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/telegram",
        {
          runId,
          status: "completed",
          payload: {
            installationId: "inst-123",
            // Missing required fields
          },
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain("payload");
    });

    it("should return success for missing installation", async () => {
      const { runId, secret } = await setupTelegramCallback();

      const payload: TelegramCallbackPayload = {
        installationId: "00000000-0000-0000-0000-000000000000",
        chatId: "123",
        messageId: "1",
        userLinkId: "link-123",
        agentId: "compose-123",
        existingSessionId: null,
        isDM: false,
        thinkingMessageId: null,
      };

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/telegram",
        { runId, status: "completed", payload },
        secret,
      );
      const response = await POST(request);

      // Missing installation returns 200 (graceful, don't retry)
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });
  });
});
