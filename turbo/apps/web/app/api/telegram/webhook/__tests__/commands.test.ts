import { describe, it, expect, beforeEach } from "vitest";
import { HttpResponse } from "msw";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import {
  createTestCompose,
  createTestAgentSession,
  createTelegramCallbackInstallation,
  getOrgMembersEntry,
  insertOrgModelPolicy,
  insertUserModelPreference,
  telegramUserLinkExists,
  createTelegramThreadSession,
  telegramThreadSessionExists,
  createTestRequest,
} from "../../../../../src/__tests__/api-test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { server } from "../../../../../src/mocks/server";
import { http } from "../../../../../src/__tests__/msw";
import { POST } from "../[telegramBotId]/route";
import { PATCH as updateComposeMetadata } from "../../../agent/composes/[id]/metadata/route";
import { seedTestRun } from "../../../../../src/__tests__/db-test-seeders/runs";

const context = testContext();

const TEST_BOT_TOKEN = "123456:ABC-commands-test";
const WEBHOOK_SECRET = "webhook-secret";
const TELEGRAM_USER_ID = 12345;
const TEST_AGENT_DISPLAY_NAME = "Telegram Helper";

interface TelegramSendMessageBody {
  chat_id: string;
  text: string;
  reply_markup?: {
    inline_keyboard: Array<Array<{ text: string; url: string }>>;
  };
}

function createWebhookRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/telegram/webhook/test", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-telegram-bot-api-secret-token": WEBHOOK_SECRET,
    },
    body: JSON.stringify(body),
  });
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
        result: { message_id: 999, chat: { id: TELEGRAM_USER_ID } },
      });
    },
  );
  return { ...handler, calls };
}

function telegramSendChatAction() {
  return http.post(
    `https://api.telegram.org/bot${TEST_BOT_TOKEN}/sendChatAction`,
    () => {
      return HttpResponse.json({ ok: true, result: true });
    },
  );
}

async function updateAgentDisplayName(
  composeId: string,
  displayName = TEST_AGENT_DISPLAY_NAME,
): Promise<void> {
  const response = await updateComposeMetadata(
    createTestRequest(
      `http://localhost:3000/api/agent/composes/${composeId}/metadata`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName }),
      },
    ),
  );
  expect(response.status).toBe(200);
}

describe("Telegram bot commands", () => {
  let installationId: string;
  let composeId: string;
  let composeName: string;
  let userLinkId: string;
  let userId: string;
  let orgId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    userId = user.userId;
    orgId = user.orgId;
    const compose = await createTestCompose(uniqueId("agent"));
    composeId = compose.composeId;
    composeName = compose.name;
    await updateAgentDisplayName(composeId);

    const result = await createTelegramCallbackInstallation(
      composeId,
      user.userId,
      TEST_BOT_TOKEN,
      { telegramUserId: String(TELEGRAM_USER_ID) },
    );
    installationId = result.installationId;
    userLinkId = result.userLinkId;

    mockClerk({ userId: user.userId });
  });

  describe("command routing with @username targeting", () => {
    it("should route command with matching @botUsername", async () => {
      const sendMsg = telegramSendMessage();
      server.use(sendMsg.handler);

      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: TELEGRAM_USER_ID, type: "private" },
          from: { id: TELEGRAM_USER_ID, username: "testuser" },
          text: "/help@test_bot",
        },
      });

      const response = await POST(request, {
        params: Promise.resolve({ telegramBotId: installationId }),
      });
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      expect(sendMsg.mocked).toHaveBeenCalled();
      expect(sendMsg.calls[0]?.text).toContain(
        `${TEST_AGENT_DISPLAY_NAME} Telegram Bot Help`,
      );
    });

    it("should ignore command targeted at a different bot", async () => {
      const sendMsg = telegramSendMessage();
      server.use(sendMsg.handler);

      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: TELEGRAM_USER_ID, type: "group" },
          from: { id: TELEGRAM_USER_ID, username: "testuser" },
          text: "/help@other_bot",
        },
      });

      const response = await POST(request, {
        params: Promise.resolve({ telegramBotId: installationId }),
      });
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      // No message sent — command was for a different bot
      expect(sendMsg.mocked).not.toHaveBeenCalled();
    });

    it("should route command without @suffix in group chat", async () => {
      const sendMsg = telegramSendMessage();
      server.use(sendMsg.handler);

      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: TELEGRAM_USER_ID, type: "group" },
          from: { id: TELEGRAM_USER_ID, username: "testuser" },
          text: "/help",
        },
      });

      const response = await POST(request, {
        params: Promise.resolve({ telegramBotId: installationId }),
      });
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      expect(sendMsg.mocked).toHaveBeenCalled();
      expect(sendMsg.calls[0]?.text).toContain(
        `${TEST_AGENT_DISPLAY_NAME} Telegram Bot Help`,
      );
    });

    it("should handle case-insensitive @botUsername matching", async () => {
      const sendMsg = telegramSendMessage();
      server.use(sendMsg.handler);

      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: TELEGRAM_USER_ID, type: "private" },
          from: { id: TELEGRAM_USER_ID, username: "testuser" },
          text: "/help@TEST_BOT",
        },
      });

      const response = await POST(request, {
        params: Promise.resolve({ telegramBotId: installationId }),
      });
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      expect(sendMsg.mocked).toHaveBeenCalled();
      expect(sendMsg.calls[0]?.text).toContain(
        `${TEST_AGENT_DISPLAY_NAME} Telegram Bot Help`,
      );
    });
  });

  describe("/connect command - group chat security", () => {
    it("should not expose connect URL in group chats", async () => {
      const sendMsg = telegramSendMessage();
      server.use(sendMsg.handler);

      // Unconnected user sends /connect in a group
      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: -100123456, type: "group" },
          from: { id: 99999, username: "unknown_user" },
          text: "/connect",
        },
      });

      const response = await POST(request, {
        params: Promise.resolve({ telegramBotId: installationId }),
      });
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      expect(sendMsg.mocked).toHaveBeenCalled();
      const text = sendMsg.calls[0]?.text ?? "";
      // Should redirect to Telegram DM instead of exposing the signed connect URL
      expect(text).toContain("connect your account");
      expect(text).toContain(TEST_AGENT_DISPLAY_NAME);
      expect(text).not.toContain("?start=connect");
      expect(text).not.toContain("<a href=");
      expect(sendMsg.calls[0]?.reply_markup).toEqual({
        inline_keyboard: [
          [{ text: "Connect", url: "https://t.me/test_bot?start=connect" }],
        ],
      });
      // Should NOT contain the actual connect URL with telegramUserId
      expect(text).not.toContain("/telegram/connect?bot=");
    });
  });

  describe("/connect command", () => {
    it("should confirm when user is already connected", async () => {
      const sendMsg = telegramSendMessage();
      server.use(sendMsg.handler);

      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: TELEGRAM_USER_ID, type: "private" },
          from: { id: TELEGRAM_USER_ID, username: "testuser" },
          text: "/connect",
        },
      });

      const response = await POST(request, {
        params: Promise.resolve({ telegramBotId: installationId }),
      });
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      expect(sendMsg.mocked).toHaveBeenCalled();
      const text = sendMsg.calls[0]?.text ?? "";
      expect(text).toContain("already connected");
      expect(text).toContain(`start chatting with ${TEST_AGENT_DISPLAY_NAME}`);
      expect(text).not.toContain(composeName);
    });

    it("should send platform link button when user is not connected", async () => {
      const sendMsg = telegramSendMessage();
      server.use(sendMsg.handler);

      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 99999, type: "private" },
          from: { id: 99999, username: "unknown_user" },
          text: "/connect",
        },
      });

      const response = await POST(request, {
        params: Promise.resolve({ telegramBotId: installationId }),
      });
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      expect(sendMsg.mocked).toHaveBeenCalled();
      const text = sendMsg.calls[0]?.text ?? "";
      expect(text).toContain(`To use ${TEST_AGENT_DISPLAY_NAME} in Telegram`);
      expect(text).not.toContain("/telegram/connect?bot=");
      expect(text).not.toContain("<a href=");
      const buttonUrl =
        sendMsg.calls[0]?.reply_markup?.inline_keyboard[0]?.[0]?.url ?? "";
      expect(buttonUrl).toContain("/telegram/connect?bot=");
      expect(buttonUrl).toContain("tgUser=99999");
    });

    it("should escape agent display name in connect prompts", async () => {
      await updateAgentDisplayName(composeId, "Helper <b>& Co");
      const sendMsg = telegramSendMessage();
      server.use(sendMsg.handler);

      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 99999, type: "private" },
          from: { id: 99999, username: "unknown_user" },
          text: "/connect",
        },
      });

      const response = await POST(request, {
        params: Promise.resolve({ telegramBotId: installationId }),
      });
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      expect(sendMsg.mocked).toHaveBeenCalled();
      const text = sendMsg.calls[0]?.text ?? "";
      expect(text).toContain("Helper &lt;b&gt;&amp; Co");
      expect(text).not.toContain("Helper <b>& Co");
    });
  });

  describe("/disconnect command", () => {
    it("should disconnect linked user and remove user link", async () => {
      const sendMsg = telegramSendMessage();
      server.use(sendMsg.handler);

      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: TELEGRAM_USER_ID, type: "private" },
          from: { id: TELEGRAM_USER_ID, username: "testuser" },
          text: "/disconnect",
        },
      });

      const response = await POST(request, {
        params: Promise.resolve({ telegramBotId: installationId }),
      });
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      expect(sendMsg.mocked).toHaveBeenCalled();
      const text = sendMsg.calls[0]?.text ?? "";
      expect(text).toContain("disconnected");
      expect(text).toContain(TEST_AGENT_DISPLAY_NAME);
      expect(text).not.toContain(composeName);

      // Verify user link was deleted
      const exists = await telegramUserLinkExists(
        installationId,
        String(TELEGRAM_USER_ID),
      );
      expect(exists).toBe(false);
    });

    it("should inform user when not connected", async () => {
      const sendMsg = telegramSendMessage();
      server.use(sendMsg.handler);

      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 99999, type: "private" },
          from: { id: 99999, username: "unknown_user" },
          text: "/disconnect",
        },
      });

      const response = await POST(request, {
        params: Promise.resolve({ telegramBotId: installationId }),
      });
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      expect(sendMsg.mocked).toHaveBeenCalled();
      expect(sendMsg.calls[0]?.text).toContain("not connected");
    });
  });

  describe("/help command", () => {
    it("should list available commands", async () => {
      const sendMsg = telegramSendMessage();
      server.use(sendMsg.handler);

      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: TELEGRAM_USER_ID, type: "private" },
          from: { id: TELEGRAM_USER_ID, username: "testuser" },
          text: "/help",
        },
      });

      const response = await POST(request, {
        params: Promise.resolve({ telegramBotId: installationId }),
      });
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      expect(sendMsg.mocked).toHaveBeenCalled();
      const text = sendMsg.calls[0]?.text ?? "";
      expect(text).toContain(`${TEST_AGENT_DISPLAY_NAME} Telegram Bot Help`);
      expect(text).toContain("/new_session");
      expect(text).toContain("/connect");
      expect(text).toContain("/disconnect");
      expect(text).toContain("/model");
      expect(text).toContain(`Connect to ${TEST_AGENT_DISPLAY_NAME}`);
      expect(text).toContain(`Disconnect from ${TEST_AGENT_DISPLAY_NAME}`);
    });

    it("should match Slack-style help without admin-only copy", async () => {
      const sendMsg = telegramSendMessage();
      server.use(sendMsg.handler);

      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: TELEGRAM_USER_ID, type: "private" },
          from: { id: TELEGRAM_USER_ID, username: "testuser" },
          text: "/help",
        },
      });

      const response = await POST(request, {
        params: Promise.resolve({ telegramBotId: installationId }),
      });
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      expect(sendMsg.mocked).toHaveBeenCalled();
      expect(sendMsg.calls[0]?.text).not.toContain("admin");
    });
  });

  describe("/model command", () => {
    async function enableModelCommand(): Promise<void> {
      await insertOrgModelPolicy({
        orgId,
        model: "claude-sonnet-4-6",
        isDefault: true,
      });
      await insertOrgModelPolicy({
        orgId,
        model: "deepseek-v4-pro",
      });
      await insertOrgModelPolicy({
        orgId,
        model: "gpt-5.5",
      });
    }

    it("should list selectable models when no model argument is provided", async () => {
      await enableModelCommand();
      await insertUserModelPreference({
        orgId,
        userId,
        model: "deepseek-v4-pro",
      });
      const sendMsg = telegramSendMessage();
      server.use(sendMsg.handler);

      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: TELEGRAM_USER_ID, type: "private" },
          from: { id: TELEGRAM_USER_ID, username: "testuser" },
          text: "/model",
        },
      });

      const response = await POST(request, {
        params: Promise.resolve({ telegramBotId: installationId }),
      });
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const text = sendMsg.calls[0]?.text ?? "";
      expect(text).toContain("Available models");
      expect(text).not.toContain("/model default");
      expect(text).toContain("/model claude-sonnet-4-6");
      expect(text).toContain("/model deepseek-v4-pro");
      expect(text).toContain("DeepSeek V4 Pro");
      expect(text).not.toContain("/model gpt-5.5");
    });

    it("should persist a matched model argument", async () => {
      await enableModelCommand();
      const sendMsg = telegramSendMessage();
      server.use(sendMsg.handler);

      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: TELEGRAM_USER_ID, type: "private" },
          from: { id: TELEGRAM_USER_ID, username: "testuser" },
          text: "/model deepseek-v4-pro",
        },
      });

      const response = await POST(request, {
        params: Promise.resolve({ telegramBotId: installationId }),
      });
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const saved = await getOrgMembersEntry(orgId, userId);
      expect(saved?.selectedModel).toBe("deepseek-v4-pro");
      expect(sendMsg.calls[0]?.text).toContain("Switched to DeepSeek V4 Pro");
    });

    it("should match model display names", async () => {
      await enableModelCommand();
      const sendMsg = telegramSendMessage();
      server.use(sendMsg.handler);

      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: TELEGRAM_USER_ID, type: "private" },
          from: { id: TELEGRAM_USER_ID, username: "testuser" },
          text: "/model Claude Sonnet 4.6",
        },
      });

      const response = await POST(request, {
        params: Promise.resolve({ telegramBotId: installationId }),
      });
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const saved = await getOrgMembersEntry(orgId, userId);
      expect(saved?.selectedModel).toBe("claude-sonnet-4-6");
    });

    it("should reject the old workspace default reset argument", async () => {
      await enableModelCommand();
      await insertUserModelPreference({
        orgId,
        userId,
        model: "deepseek-v4-pro",
      });
      const sendMsg = telegramSendMessage();
      server.use(sendMsg.handler);

      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: TELEGRAM_USER_ID, type: "private" },
          from: { id: TELEGRAM_USER_ID, username: "testuser" },
          text: "/model default",
        },
      });

      const response = await POST(request, {
        params: Promise.resolve({ telegramBotId: installationId }),
      });
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const saved = await getOrgMembersEntry(orgId, userId);
      expect(saved?.selectedModel).toBe("deepseek-v4-pro");
      expect(sendMsg.calls[0]?.text).toContain(
        "Unknown model &quot;default&quot;.",
      );
      expect(sendMsg.calls[0]?.text).not.toContain("/model default");
    });

    it("should switch models without a model-first feature switch", async () => {
      const sendMsg = telegramSendMessage();
      server.use(sendMsg.handler);

      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: TELEGRAM_USER_ID, type: "private" },
          from: { id: TELEGRAM_USER_ID, username: "testuser" },
          text: "/model deepseek-v4-pro",
        },
      });

      const response = await POST(request, {
        params: Promise.resolve({ telegramBotId: installationId }),
      });
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      expect(sendMsg.calls[0]?.text).toContain("Switched to DeepSeek V4 Pro");
      const saved = await getOrgMembersEntry(orgId, userId);
      expect(saved?.selectedModel).toBe("deepseek-v4-pro");
    });
  });

  describe("/new_session command", () => {
    it("should clear DM session and send confirmation", async () => {
      // Create an agent session and thread session to be deleted
      const agentSession = await createTestAgentSession(userId, composeId);

      await createTelegramThreadSession({
        telegramUserLinkId: userLinkId,
        chatId: String(TELEGRAM_USER_ID),
        rootMessageId: "dm",
        agentSessionId: agentSession.id,
      });

      const sendMsg = telegramSendMessage();
      server.use(sendMsg.handler);

      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: TELEGRAM_USER_ID, type: "private" },
          from: { id: TELEGRAM_USER_ID, username: "testuser" },
          text: "/new_session",
        },
      });

      const response = await POST(request, {
        params: Promise.resolve({ telegramBotId: installationId }),
      });
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      // Verify confirmation message
      expect(sendMsg.mocked).toHaveBeenCalled();
      const text = sendMsg.calls[0]?.text ?? "";
      expect(text).toContain("New session started");
      expect(text).not.toContain(TEST_AGENT_DISPLAY_NAME);
      expect(text).not.toContain(composeName);

      // Verify thread session was deleted
      const exists = await telegramThreadSessionExists({
        telegramUserLinkId: userLinkId,
        chatId: String(TELEGRAM_USER_ID),
        rootMessageId: "dm",
      });
      expect(exists).toBe(false);
    });

    it("should prompt linking when user is not connected", async () => {
      const sendMsg = telegramSendMessage();
      server.use(sendMsg.handler);

      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 99999, type: "private" },
          from: { id: 99999, username: "unknown_user" },
          text: "/new_session",
        },
      });

      const response = await POST(request, {
        params: Promise.resolve({ telegramBotId: installationId }),
      });
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      expect(sendMsg.mocked).toHaveBeenCalled();
      const text = sendMsg.calls[0]?.text ?? "";
      expect(text).toContain("connect your account");
      expect(text).toContain(TEST_AGENT_DISPLAY_NAME);
      const buttonUrl =
        sendMsg.calls[0]?.reply_markup?.inline_keyboard[0]?.[0]?.url ?? "";
      expect(buttonUrl).toContain("/telegram/connect?bot=");
    });

    it("should be ignored in group chats", async () => {
      const sendMsg = telegramSendMessage();
      server.use(sendMsg.handler);

      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: TELEGRAM_USER_ID, type: "group" },
          from: { id: TELEGRAM_USER_ID, username: "testuser" },
          text: "/new_session",
        },
      });

      const response = await POST(request, {
        params: Promise.resolve({ telegramBotId: installationId }),
      });
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      // No message sent in group chat
      expect(sendMsg.mocked).not.toHaveBeenCalled();
    });
  });

  describe("queued run notification", () => {
    beforeEach(async () => {
      // Fill the org's concurrency slot (free tier = 1 concurrent run)
      // so createZeroRun returns status: "queued" naturally.
      // Use a separate compose to avoid overwriting the main compose's headVersionId.
      const { composeId: fillerComposeId } = await createTestCompose(
        uniqueId("filler"),
      );
      await seedTestRun(userId, fillerComposeId, {
        status: "running",
        startedAt: new Date(),
      });
    });

    it("should send queued message for DM when run is queued", async () => {
      const sendMsg = telegramSendMessage();
      const sendChatAction = telegramSendChatAction();
      server.use(sendMsg.handler, sendChatAction.handler);

      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: TELEGRAM_USER_ID, type: "private" },
          from: { id: TELEGRAM_USER_ID, username: "testuser" },
          text: "hello bot",
        },
      });

      const response = await POST(request, {
        params: Promise.resolve({ telegramBotId: installationId }),
      });
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      expect(sendChatAction.mocked).toHaveBeenCalledTimes(1);
      expect(sendMsg.calls[0]?.text).toContain("Run queued");
      expect(sendMsg.calls[0]?.text).not.toContain("thinking");
      expect(sendMsg.calls[0]?.text).not.toContain(composeId);
      expect(sendMsg.calls[0]?.text).not.toContain(composeName);
      expect(sendMsg.calls[0]?.text).toContain("concurrency limit reached");
    });

    it("should send queued message for group mention when run is queued", async () => {
      const sendMsg = telegramSendMessage();
      const sendChatAction = telegramSendChatAction();
      server.use(sendMsg.handler, sendChatAction.handler);

      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: TELEGRAM_USER_ID, type: "group" },
          from: { id: TELEGRAM_USER_ID, username: "testuser" },
          text: "hello @test_bot",
          entities: [{ type: "mention", offset: 6, length: 9 }],
        },
      });

      const response = await POST(request, {
        params: Promise.resolve({ telegramBotId: installationId }),
      });
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      expect(sendChatAction.mocked).toHaveBeenCalledTimes(1);
      expect(sendMsg.calls[0]?.text).toContain("Run queued");
      expect(sendMsg.calls[0]?.text).not.toContain("thinking");
      expect(sendMsg.calls[0]?.text).not.toContain(composeId);
      expect(sendMsg.calls[0]?.text).not.toContain(composeName);
      expect(sendMsg.calls[0]?.text).toContain("concurrency limit reached");
    });
  });

  describe("typing indicator", () => {
    it("should send typing without posting a thinking message", async () => {
      const sendMsg = telegramSendMessage();
      const sendChatAction = telegramSendChatAction();
      server.use(sendMsg.handler, sendChatAction.handler);

      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: TELEGRAM_USER_ID, type: "private" },
          from: { id: TELEGRAM_USER_ID, username: "testuser" },
          text: "hello bot",
        },
      });

      const response = await POST(request, {
        params: Promise.resolve({ telegramBotId: installationId }),
      });
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      expect(sendChatAction.mocked).toHaveBeenCalledTimes(1);
      expect(sendMsg.mocked).not.toHaveBeenCalled();
    });
  });
});
