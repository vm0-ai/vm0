import { describe, it, expect, beforeEach } from "vitest";
import { HttpResponse } from "msw";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import {
  createTestCompose,
  createTelegramInstallation,
  createTelegramPendingLinkInstallation,
  PENDING_TELEGRAM_USER_ID,
} from "../../../../../src/__tests__/api-test-helpers";
import { GET as linkGET } from "../../../../api/integrations/telegram/link/route";
import { server } from "../../../../../src/mocks/server";
import { http } from "../../../../../src/__tests__/msw";
import { POST } from "../[telegramBotId]/route";
import {
  nextAfterArgForms,
  nextAfterCallbacks,
} from "../../../../../src/__tests__/next-after-hooks";

// Uses the shared `next/server` mock from src/__tests__/setup.ts, which records
// both the argument form (nextAfterArgForms) and the callback queue
// (nextAfterCallbacks) in src/__tests__/next-after-hooks.ts. Tests draining
// the queue use the helper below; regression tests that only care about the
// argument form assert on nextAfterArgForms directly.
async function flushAfterCallbacks() {
  const callbacks = [...nextAfterCallbacks];
  nextAfterCallbacks.length = 0;
  await Promise.all(
    callbacks.map((cb) => {
      return cb();
    }),
  );
}

const context = testContext();

const WEBHOOK_SECRET = "webhook-secret";
const TEST_BOT_TOKEN = "123456:ABC-pending-test";

function createWebhookRequest(
  body: Record<string, unknown>,
  secret: string = WEBHOOK_SECRET,
): Request {
  return new Request("http://localhost/api/telegram/webhook/test", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/telegram/webhook/[telegramBotId]", () => {
  let telegramBotId: string;

  beforeEach(async () => {
    telegramBotId = await createTelegramInstallation();
  });

  it("should return 404 for unknown installation", async () => {
    const request = createWebhookRequest({
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 123, type: "private" },
        text: "hi",
      },
    });
    const response = await POST(request, {
      params: Promise.resolve({
        telegramBotId: "unknown-bot-id",
      }),
    });
    expect(response.status).toBe(404);
  });

  it("should return 401 for invalid webhook secret", async () => {
    const request = createWebhookRequest(
      {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 123, type: "private" },
          text: "hi",
        },
      },
      "wrong-secret",
    );
    const response = await POST(request, {
      params: Promise.resolve({ telegramBotId }),
    });
    expect(response.status).toBe(401);
  });

  it("should return 401 for missing webhook secret header", async () => {
    const request = new Request("http://localhost/api/telegram/webhook/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 123, type: "private" },
          text: "hi",
        },
      }),
    });
    const response = await POST(request, {
      params: Promise.resolve({ telegramBotId }),
    });
    expect(response.status).toBe(401);
  });

  it("should return 200 for valid request with no message", async () => {
    const request = createWebhookRequest({ update_id: 1 });
    const response = await POST(request, {
      params: Promise.resolve({ telegramBotId }),
    });
    expect(response.status).toBe(200);
  });

  it("should return 200 for message without text", async () => {
    const request = createWebhookRequest({
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 123, type: "private" },
        from: { id: 456, username: "testuser" },
      },
    });
    const response = await POST(request, {
      params: Promise.resolve({ telegramBotId }),
    });
    expect(response.status).toBe(200);
  });

  it("should return 200 immediately for valid text messages", async () => {
    const request = createWebhookRequest({
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 123, type: "private" },
        from: { id: 456, username: "testuser" },
        text: "hello bot",
      },
    });

    const response = await POST(request, {
      params: Promise.resolve({ telegramBotId }),
    });

    // Should return 200 immediately (handler runs in after())
    expect(response.status).toBe(200);

    // after() was called (handler was dispatched)
    expect(nextAfterCallbacks.length).toBe(1);

    // Handler errors are caught gracefully (no unhandled rejections)
    await flushAfterCallbacks();
  });

  it("should return 200 for /start command", async () => {
    const request = createWebhookRequest({
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 123, type: "private" },
        from: { id: 456, username: "testuser" },
        text: "/start sometoken",
      },
    });

    const response = await POST(request, {
      params: Promise.resolve({ telegramBotId }),
    });

    expect(response.status).toBe(200);
    expect(nextAfterCallbacks.length).toBe(1);
    await flushAfterCallbacks();
  });

  it("should return 400 for invalid JSON", async () => {
    const request = new Request("http://localhost/api/telegram/webhook/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": WEBHOOK_SECRET,
      },
      body: "not json",
    });
    const response = await POST(request, {
      params: Promise.resolve({ telegramBotId }),
    });
    expect(response.status).toBe(400);
  });

  describe("auto-complete pending link", () => {
    it("should complete pending link on first DM from admin", async () => {
      context.setupMocks();
      const user = await context.setupUser();
      const { composeId } = await createTestCompose(uniqueId("agent"));

      const pending = await createTelegramPendingLinkInstallation(
        composeId,
        user.userId,
        TEST_BOT_TOKEN,
      );

      // Set up MSW handlers for Telegram API calls the DM handler makes
      const sendChatActionHandler = http.post(
        `https://api.telegram.org/bot${TEST_BOT_TOKEN}/sendChatAction`,
        () => {
          return HttpResponse.json({ ok: true, result: true });
        },
      );
      const sendMessageHandler = http.post(
        `https://api.telegram.org/bot${TEST_BOT_TOKEN}/sendMessage`,
        () => {
          return HttpResponse.json({
            ok: true,
            result: { message_id: 99, chat: { id: 789 } },
          });
        },
      );
      server.use(sendChatActionHandler.handler, sendMessageHandler.handler);

      // Verify the link is pending before the webhook
      const beforeResponse = await linkGET(
        new Request("http://localhost:3000/api/integrations/telegram/link"),
      );
      const beforeData = await beforeResponse.json();
      expect(beforeData.linked).toBe(true);
      expect(beforeData.telegramUserId).toBe(PENDING_TELEGRAM_USER_ID);

      // Send a DM as the admin (telegramUserId = "789")
      const telegramUserId = 789;
      const request = createWebhookRequest({
        update_id: 100,
        message: {
          message_id: 1,
          chat: { id: telegramUserId, type: "private" },
          from: { id: telegramUserId, username: "admin_user" },
          text: "hello bot",
        },
      });

      const response = await POST(request, {
        params: Promise.resolve({
          telegramBotId: pending.installationId,
        }),
      });
      expect(response.status).toBe(200);

      // Flush the after() callback so the DM handler runs
      await flushAfterCallbacks();

      // Verify the pending link was completed with the real Telegram user ID
      const afterResponse = await linkGET(
        new Request("http://localhost:3000/api/integrations/telegram/link"),
      );
      const afterData = await afterResponse.json();
      expect(afterData.linked).toBe(true);
      expect(afterData.telegramUserId).toBe(String(telegramUserId));
    });
  });

  // Regression: createZeroRun schedules its Phase 2 dispatch via a nested
  // after() inside handleTelegramDirectMessage / handleTelegramMention. If the
  // route registers the outer after() with an already-started promise, the
  // nested after() is scheduled after the Next.js request context has been
  // finalized and Phase 2 dispatch never runs — runs remain Pending forever.
  describe("after() callback form (nested-after propagation)", () => {
    it("registers DM handler via callback form", async () => {
      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 123, type: "private" },
          from: { id: 456, username: "testuser" },
          text: "hello",
        },
      });

      await POST(request, {
        params: Promise.resolve({ telegramBotId }),
      });

      expect(nextAfterArgForms).toEqual(["fn"]);
    });

    it("registers @mention handler via callback form", async () => {
      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 123, type: "group" },
          from: { id: 456, username: "testuser" },
          text: "@test_bot hi",
          entities: [{ type: "mention", offset: 0, length: 9 }],
        },
      });

      await POST(request, {
        params: Promise.resolve({ telegramBotId }),
      });

      expect(nextAfterArgForms).toEqual(["fn"]);
    });

    it("registers reply-to-bot handler via callback form", async () => {
      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 123, type: "group" },
          from: { id: 456, username: "testuser" },
          text: "thanks",
          reply_to_message: {
            message_id: 99,
            chat: { id: 123, type: "group" },
            from: { id: 1, is_bot: true, username: "test_bot" },
          },
        },
      });

      await POST(request, {
        params: Promise.resolve({ telegramBotId }),
      });

      expect(nextAfterArgForms).toEqual(["fn"]);
    });

    it("registers /start command handler via callback form", async () => {
      const request = createWebhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 123, type: "private" },
          from: { id: 456, username: "testuser" },
          text: "/start sometoken",
        },
      });

      await POST(request, {
        params: Promise.resolve({ telegramBotId }),
      });

      expect(nextAfterArgForms).toEqual(["fn"]);
    });
  });
});
