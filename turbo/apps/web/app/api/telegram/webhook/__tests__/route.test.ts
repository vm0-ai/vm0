import { describe, it, expect, vi, beforeEach } from "vitest";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { createTelegramInstallation } from "../../../../../src/lib/telegram/__tests__/helpers";
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

testContext();

const WEBHOOK_SECRET = "webhook-secret";

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
});
