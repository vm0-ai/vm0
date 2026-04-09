import { describe, it, expect, vi, beforeEach } from "vitest";
import { HttpResponse } from "msw";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import {
  createTestCompose,
  createTestAgentSession,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  createTelegramCallbackInstallation,
  telegramUserLinkExists,
  createTelegramThreadSession,
  telegramThreadSessionExists,
} from "../../../../../src/__tests__/api-test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { server } from "../../../../../src/mocks/server";
import { http } from "../../../../../src/__tests__/msw";
import { POST } from "../[installationId]/route";
import * as zeroRunModule from "../../../../../src/lib/zero/zero-run-service";

// Mock Next.js after() to execute synchronously
const afterPromises: Promise<unknown>[] = [];
vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("next/server")>();
  return {
    ...original,
    after: (promise: Promise<unknown>) => {
      afterPromises.push(promise);
    },
  };
});

async function flushAfterCallbacks() {
  await Promise.all(afterPromises);
  afterPromises.length = 0;
}

const context = testContext();

const TEST_BOT_TOKEN = "123456:ABC-commands-test";
const WEBHOOK_SECRET = "webhook-secret";
const TELEGRAM_USER_ID = 12345;

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
  const calls: Array<{ chat_id: string; text: string }> = [];
  const handler = http.post(
    `https://api.telegram.org/bot${TEST_BOT_TOKEN}/sendMessage`,
    async ({ request }) => {
      const body = (await request.json()) as {
        chat_id: string;
        text: string;
      };
      calls.push(body);
      return HttpResponse.json({
        ok: true,
        result: { message_id: 999, chat: { id: TELEGRAM_USER_ID } },
      });
    },
  );
  return { ...handler, calls };
}

function telegramEditMessageText() {
  const calls: Array<{
    chat_id: string;
    message_id: number;
    text: string;
  }> = [];
  const handler = http.post(
    `https://api.telegram.org/bot${TEST_BOT_TOKEN}/editMessageText`,
    async ({ request }) => {
      const body = (await request.json()) as {
        chat_id: string;
        message_id: number;
        text: string;
      };
      calls.push(body);
      return HttpResponse.json({
        ok: true,
        result: {
          message_id: body.message_id,
          chat: { id: TELEGRAM_USER_ID },
        },
      });
    },
  );
  return { ...handler, calls };
}

describe("Telegram bot commands", () => {
  let installationId: string;
  let composeId: string;
  let userLinkId: string;
  let userId: string;

  beforeEach(async () => {
    afterPromises.length = 0;
    context.setupMocks();
    const user = await context.setupUser();
    userId = user.userId;
    const compose = await createTestCompose(uniqueId("agent"));
    composeId = compose.composeId;

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
        params: Promise.resolve({ installationId }),
      });
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      expect(sendMsg.mocked).toHaveBeenCalled();
      expect(sendMsg.calls[0]?.text).toContain("/help");
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
        params: Promise.resolve({ installationId }),
      });
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

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
        params: Promise.resolve({ installationId }),
      });
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      expect(sendMsg.mocked).toHaveBeenCalled();
      expect(sendMsg.calls[0]?.text).toContain("/help");
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
        params: Promise.resolve({ installationId }),
      });
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      expect(sendMsg.mocked).toHaveBeenCalled();
      expect(sendMsg.calls[0]?.text).toContain("/help");
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
        params: Promise.resolve({ installationId }),
      });
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      expect(sendMsg.mocked).toHaveBeenCalled();
      const text = sendMsg.calls[0]?.text ?? "";
      // Should redirect to DM instead of exposing the connect URL
      expect(text).toContain("private message");
      expect(text).toContain("?start=connect");
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
        params: Promise.resolve({ installationId }),
      });
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      expect(sendMsg.mocked).toHaveBeenCalled();
      expect(sendMsg.calls[0]?.text).toContain("already connected");
    });

    it("should send platform link with bot param when user is not connected", async () => {
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
        params: Promise.resolve({ installationId }),
      });
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      expect(sendMsg.mocked).toHaveBeenCalled();
      expect(sendMsg.calls[0]?.text).toContain("/telegram/connect?bot=");
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
        params: Promise.resolve({ installationId }),
      });
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      expect(sendMsg.mocked).toHaveBeenCalled();
      expect(sendMsg.calls[0]?.text).toContain("disconnected");

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
        params: Promise.resolve({ installationId }),
      });
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

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
        params: Promise.resolve({ installationId }),
      });
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      expect(sendMsg.mocked).toHaveBeenCalled();
      const text = sendMsg.calls[0]?.text ?? "";
      expect(text).toContain("/new_session");
      expect(text).toContain("/connect");
      expect(text).toContain("/disconnect");
      expect(text).toContain("/help");
    });

    it("should include admin notice for admin user", async () => {
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
        params: Promise.resolve({ installationId }),
      });
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      expect(sendMsg.mocked).toHaveBeenCalled();
      expect(sendMsg.calls[0]?.text).toContain("admin");
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
        params: Promise.resolve({ installationId }),
      });
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      // Verify confirmation message
      expect(sendMsg.mocked).toHaveBeenCalled();
      expect(sendMsg.calls[0]?.text).toContain("New session started");

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
        params: Promise.resolve({ installationId }),
      });
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      expect(sendMsg.mocked).toHaveBeenCalled();
      expect(sendMsg.calls[0]?.text).toContain("Connect your account");
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
        params: Promise.resolve({ installationId }),
      });
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      // No message sent in group chat
      expect(sendMsg.mocked).not.toHaveBeenCalled();
    });
  });

  describe("queued run notification", () => {
    it("should send queued message for DM when run is queued", async () => {
      const sendMsg = telegramSendMessage();
      const editMsg = telegramEditMessageText();
      server.use(sendMsg.handler, editMsg.handler);

      vi.spyOn(zeroRunModule, "createZeroRun").mockResolvedValue({
        runId: "mock-run-id",
        status: "queued",
        createdAt: new Date(),
      });

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
        params: Promise.resolve({ installationId }),
      });
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      // Queued notification edits the thinking message (not a new sendMessage)
      const queuedMsg = editMsg.calls.find((c) => {
        return c.text.includes("Run queued");
      });
      expect(queuedMsg).toBeDefined();
      expect(queuedMsg?.text).toContain("concurrency limit reached");
    });

    it("should send queued message for group mention when run is queued", async () => {
      const sendMsg = telegramSendMessage();
      const editMsg = telegramEditMessageText();
      server.use(sendMsg.handler, editMsg.handler);

      vi.spyOn(zeroRunModule, "createZeroRun").mockResolvedValue({
        runId: "mock-run-id",
        status: "queued",
        createdAt: new Date(),
      });

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
        params: Promise.resolve({ installationId }),
      });
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      // Queued notification edits the thinking message (not a new sendMessage)
      const queuedMsg = editMsg.calls.find((c) => {
        return c.text.includes("Run queued");
      });
      expect(queuedMsg).toBeDefined();
      expect(queuedMsg?.text).toContain("concurrency limit reached");
    });
  });
});
