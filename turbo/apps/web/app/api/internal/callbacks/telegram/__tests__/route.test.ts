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
  findTelegramThreadAgentSessionId,
  findTestRunRecord,
  insertTestTelegramUserLink,
  createTelegramThreadSession,
} from "../../../../../../src/__tests__/api-test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { server } from "../../../../../../src/mocks/server";
import { http } from "../../../../../../src/__tests__/msw";
import {
  seedTestRun,
  setTestRunSelectedModel,
} from "../../../../../../src/__tests__/db-test-seeders/runs";
import { seedUserFeatureSwitches } from "../../../../../../src/__tests__/db-test-seeders/feature-switches";
import { createTestZeroAgent } from "../../../../../../src/__tests__/db-test-seeders/agents";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

const context = testContext();

const TEST_BOT_TOKEN = "123456:ABC-test-telegram-callback";

interface TelegramCallbackPayload {
  installationId: string;
  chatId: string;
  messageId: string;
  rootMessageId?: string | null;
  userLinkId: string;
  agentId: string;
  existingSessionId: string | null;
  isDM: boolean;
  thinkingMessageId?: string | null;
}

function telegramSendChatAction() {
  return http.post(
    `https://api.telegram.org/bot${TEST_BOT_TOKEN}/sendChatAction`,
    () => {
      return HttpResponse.json({ ok: true, result: true });
    },
  );
}

interface TelegramSendMessageBody {
  chat_id: string;
  text: string;
  parse_mode?: string;
  reply_parameters?: { message_id: number };
}

function telegramSendMessage() {
  const calls: TelegramSendMessageBody[] = [];
  const handler = http.post(
    `https://api.telegram.org/bot${TEST_BOT_TOKEN}/sendMessage`,
    async ({ request }) => {
      const body = (await request.json()) as TelegramSendMessageBody;
      calls.push(body);
      return HttpResponse.json({
        ok: true,
        result: {
          message_id: 999,
          chat: { id: 123 },
          text: body.text,
        },
      });
    },
  );
  return { ...handler, calls };
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
  const org = await createTestOrg(uniqueId("org"));
  const { composeId, name: composeName } = await createTestCompose(
    uniqueId("telegram-agent"),
  );

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
  };

  const { secret } = await createTestCallback({
    runId,
    url: "http://localhost/api/internal/callbacks/telegram",
    payload: { ...payload },
  });

  return {
    installationId,
    composeId,
    composeName,
    orgId: org.id,
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
    it("should omit audit link when AuditLink switch is off", async () => {
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
      expect(chatActionHandler.mocked).toHaveBeenCalledTimes(1);
      expect(deleteMessageHandler.mocked).not.toHaveBeenCalled();
      expect(sendMessageHandler.mocked).toHaveBeenCalledTimes(1);
      const text = sendMessageHandler.calls[0]?.text ?? "";
      expect(text).not.toContain("🤖");
      expect(text).not.toContain("📋 Audit");
    });

    it("should include audit link when AuditLink switch is on", async () => {
      const { orgId, userId, runId, payload, secret } =
        await setupTelegramCallback();
      await seedUserFeatureSwitches(orgId, userId, {
        [FeatureSwitchKey.AuditLink]: true,
      });

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

      const text = sendMessageHandler.calls[0]?.text ?? "";
      expect(text).toContain("📋 Audit");
      expect(text).toContain(`/activities/${runId}`);
    });

    it("renders Slack-aligned attribution footer for agent replies", async () => {
      const user = await context.setupUser();
      const { composeId: defaultComposeId } = await createTestCompose(
        uniqueId("default-agent"),
      );
      const responderName = uniqueId("responder");
      const { composeId: responderComposeId } =
        await createTestCompose(responderName);
      await createTestZeroAgent(user.orgId, responderName, {
        displayName: "Responder",
      });

      const { installationId, userLinkId } =
        await createTelegramCallbackInstallation(
          defaultComposeId,
          user.userId,
          TEST_BOT_TOKEN,
          { telegramUserId: "777000" },
        );
      const otherUserId = uniqueId("other-user");
      const otherLink = await insertTestTelegramUserLink({
        installationId,
        telegramUserId: "888000",
        vm0UserId: otherUserId,
      });
      const otherSession = await createTestAgentSession(
        otherUserId,
        responderComposeId,
      );
      const chatId = uniqueId("chat");
      const rootMessageId = "100";
      await createTelegramThreadSession({
        telegramUserLinkId: otherLink.id,
        chatId,
        rootMessageId,
        agentSessionId: otherSession.id,
      });

      const { runId } = await seedTestRun(user.userId, responderComposeId, {
        prompt: "Test prompt",
      });
      await setTestRunSelectedModel(runId, "claude-opus-4-7");
      const payload: TelegramCallbackPayload = {
        installationId,
        chatId,
        messageId: "42",
        rootMessageId,
        userLinkId,
        agentId: responderComposeId,
        existingSessionId: null,
        isDM: false,
      };
      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/telegram",
        payload: { ...payload },
      });

      const chatActionHandler = telegramSendChatAction();
      const sendMessageHandler = telegramSendMessage();
      server.use(chatActionHandler.handler, sendMessageHandler.handler);

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/telegram",
        { runId, status: "completed", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const text = sendMessageHandler.calls[0]?.text ?? "";
      expect(text).toContain("<i>Responded by Responder · Claude Opus 4.7</i>");
      expect(text).not.toContain("Reply to");
    });

    it("renders markdown for group mention replies", async () => {
      const { runId, payload, secret } = await setupTelegramCallback();

      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
        { eventData: { result: "**Done** with `code`" } },
      ]);

      const chatActionHandler = telegramSendChatAction();
      const sendMessageHandler = telegramSendMessage();
      server.use(chatActionHandler.handler, sendMessageHandler.handler);

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/telegram",
        { runId, status: "completed", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const sent = sendMessageHandler.calls[0]!;
      expect(sent.text).toContain("<b>Done</b> with <code>code</code>");
      expect(sent.parse_mode).toBe("HTML");
      expect(sent.reply_parameters).toEqual({
        message_id: Number(payload.messageId),
      });
    });

    it("renders connector authorization links in agent replies", async () => {
      const { runId, payload, secret } = await setupTelegramCallback();

      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
        {
          eventData: {
            result: [
              "Notion 还没有连接，需要先授权。",
              "",
              "请点击这个链接完成连接：",
              "[连接 Notion](https://tunnel-yuma-vm0-app.vm7.ai/connectors/notion/connect?agentId=b431c9a7-4f78-4977-aba1-dec4c04b212c)",
            ].join("\n"),
          },
        },
      ]);

      const chatActionHandler = telegramSendChatAction();
      const sendMessageHandler = telegramSendMessage();
      server.use(chatActionHandler.handler, sendMessageHandler.handler);

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/telegram",
        { runId, status: "completed", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const sent = sendMessageHandler.calls[0]!;
      expect(sent.parse_mode).toBe("HTML");
      expect(sent.text).toContain(
        '<a href="https://tunnel-yuma-vm0-app.vm7.ai/connectors/notion/connect?agentId=b431c9a7-4f78-4977-aba1-dec4c04b212c">连接 Notion</a>',
      );
      expect(sent.text).not.toContain("[连接 Notion](");
    });

    it("renders markdown for DM replies without reply quoting", async () => {
      const { runId, payload, secret } = await setupTelegramCallback();

      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
        { eventData: { result: "**Done** with `code`" } },
      ]);

      const chatActionHandler = telegramSendChatAction();
      const sendMessageHandler = telegramSendMessage();
      server.use(chatActionHandler.handler, sendMessageHandler.handler);

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/telegram",
        { runId, status: "completed", payload: { ...payload, isDM: true } },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const sent = sendMessageHandler.calls[0]!;
      expect(sent.text).toContain("<b>Done</b> with <code>code</code>");
      expect(sent.reply_parameters).toBeUndefined();
    });

    it("replaces an existing DM mapping when a new session was started", async () => {
      const { userId, composeId, runId, payload, secret } =
        await setupTelegramCallback();
      const run = await findTestRunRecord(runId);
      const oldSession = await createTestAgentSession(userId, composeId);
      await createTelegramThreadSession({
        telegramUserLinkId: payload.userLinkId,
        chatId: payload.chatId,
        rootMessageId: "dm",
        agentSessionId: oldSession.id,
      });

      const chatActionHandler = telegramSendChatAction();
      const sendMessageHandler = telegramSendMessage();
      server.use(chatActionHandler.handler, sendMessageHandler.handler);

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/telegram",
        {
          runId,
          status: "completed",
          payload: {
            ...payload,
            rootMessageId: "dm",
            existingSessionId: null,
            isDM: true,
          },
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const agentSessionId = await findTelegramThreadAgentSessionId({
        telegramUserLinkId: payload.userLinkId,
        chatId: payload.chatId,
        rootMessageId: "dm",
      });
      expect(agentSessionId).toBe(run?.sessionId);
      expect(agentSessionId).not.toBe(oldSession.id);
    });

    it("should delete legacy thinking placeholder when present", async () => {
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
          payload: { ...payload, thinkingMessageId: "100" },
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(deleteMessageHandler.mocked).toHaveBeenCalledTimes(1);
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

    it("renders markdown links in failed run messages", async () => {
      const { runId, payload, secret } = await setupTelegramCallback();

      const chatActionHandler = telegramSendChatAction();
      const sendMessageHandler = telegramSendMessage();
      server.use(chatActionHandler.handler, sendMessageHandler.handler);

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/telegram",
        {
          runId,
          status: "failed",
          error: "请先 [连接 Notion](https://example.com/connect?agentId=123)",
          payload,
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const sent = sendMessageHandler.calls[0]!;
      expect(sent.parse_mode).toBe("HTML");
      expect(sent.text).toContain(
        '<a href="https://example.com/connect?agentId=123">连接 Notion</a>',
      );
      expect(sent.text).not.toContain("[连接 Notion](");
    });
  });

  describe("Progress Callback", () => {
    it("should refresh typing indicator and return early without sending a message", async () => {
      const { runId, payload, secret } = await setupTelegramCallback();

      const chatActionHandler = telegramSendChatAction();
      const sendMessageHandler = telegramSendMessage();
      server.use(chatActionHandler.handler, sendMessageHandler.handler);

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
      // Should NOT send a new message
      expect(sendMessageHandler.mocked).not.toHaveBeenCalled();
    });

    it("should ignore legacy thinking placeholders on progress", async () => {
      const { runId, payload, secret } = await setupTelegramCallback();

      const chatActionHandler = telegramSendChatAction();
      const sendMessageHandler = telegramSendMessage();
      server.use(chatActionHandler.handler, sendMessageHandler.handler);

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/telegram",
        {
          runId,
          status: "progress",
          payload: { ...payload, thinkingMessageId: "100" },
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(chatActionHandler.mocked).toHaveBeenCalledTimes(1);
      expect(sendMessageHandler.mocked).not.toHaveBeenCalled();
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
