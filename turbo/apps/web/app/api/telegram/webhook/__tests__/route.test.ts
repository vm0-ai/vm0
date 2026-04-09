import { describe, it, expect, vi, beforeEach } from "vitest";
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
import { POST } from "../[installationId]/route";

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

describe("POST /api/telegram/webhook/[installationId]", () => {
  let installationId: string;

  beforeEach(async () => {
    afterPromises.length = 0;
    installationId = await createTelegramInstallation();
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
        installationId: "00000000-0000-0000-0000-000000000000",
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
      params: Promise.resolve({ installationId }),
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
      params: Promise.resolve({ installationId }),
    });
    expect(response.status).toBe(401);
  });

  it("should return 200 for valid request with no message", async () => {
    const request = createWebhookRequest({ update_id: 1 });
    const response = await POST(request, {
      params: Promise.resolve({ installationId }),
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
      params: Promise.resolve({ installationId }),
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
      params: Promise.resolve({ installationId }),
    });

    // Should return 200 immediately (handler runs in after())
    expect(response.status).toBe(200);

    // after() was called (handler was dispatched)
    expect(afterPromises.length).toBe(1);

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
      params: Promise.resolve({ installationId }),
    });

    expect(response.status).toBe(200);
    expect(afterPromises.length).toBe(1);
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
      params: Promise.resolve({ installationId }),
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
          installationId: pending.installationId,
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
});
