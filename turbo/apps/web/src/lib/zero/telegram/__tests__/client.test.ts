import { describe, it, expect } from "vitest";
import { HttpResponse } from "msw";
import {
  callTelegramApi,
  createTelegramClient,
  sendMessage,
  sendChatAction,
  editMessageText,
  deleteMessage,
  getMe,
  setWebhook,
  deleteWebhook,
  setMyCommands,
} from "../client";
import { server } from "../../../../mocks/server";
import { http } from "../../../../__tests__/msw";

const TEST_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";

describe("createTelegramClient", () => {
  it("should return a client with the given token", () => {
    const client = createTelegramClient(TEST_TOKEN);
    expect(client).toEqual({ token: TEST_TOKEN });
  });
});

describe("callTelegramApi", () => {
  it("should call the Telegram API and return the result", async () => {
    const handler = http.post(
      `https://api.telegram.org/bot${TEST_TOKEN}/getMe`,
      () => {
        return HttpResponse.json({
          ok: true,
          result: {
            id: 123,
            is_bot: true,
            first_name: "TestBot",
            username: "test_bot",
          },
        });
      },
    );
    server.use(handler.handler);

    const result = await callTelegramApi<{ id: number; username: string }>(
      TEST_TOKEN,
      "getMe",
    );

    expect(result).toEqual({
      id: 123,
      is_bot: true,
      first_name: "TestBot",
      username: "test_bot",
    });
    expect(handler.mocked).toHaveBeenCalledTimes(1);
  });

  it("should send params as JSON body", async () => {
    let capturedBody: unknown;
    const handler = http.post(
      `https://api.telegram.org/bot${TEST_TOKEN}/sendMessage`,
      async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          ok: true,
          result: { message_id: 1, chat: { id: 42 }, text: "hello" },
        });
      },
    );
    server.use(handler.handler);

    await callTelegramApi(TEST_TOKEN, "sendMessage", {
      chat_id: 42,
      text: "hello",
    });

    expect(capturedBody).toEqual({ chat_id: 42, text: "hello" });
  });

  it("should throw on API error with description", async () => {
    const handler = http.post(
      `https://api.telegram.org/bot${TEST_TOKEN}/sendMessage`,
      () => {
        return HttpResponse.json(
          { ok: false, description: "Bad Request: chat not found" },
          { status: 400 },
        );
      },
    );
    server.use(handler.handler);

    await expect(
      callTelegramApi(TEST_TOKEN, "sendMessage", { chat_id: -1 }),
    ).rejects.toThrow(
      "Telegram API error (sendMessage): Bad Request: chat not found",
    );
  });

  it("should throw on API error with HTTP status when no description", async () => {
    const handler = http.post(
      `https://api.telegram.org/bot${TEST_TOKEN}/getMe`,
      () => {
        return HttpResponse.json({ ok: false }, { status: 500 });
      },
    );
    server.use(handler.handler);

    await expect(callTelegramApi(TEST_TOKEN, "getMe")).rejects.toThrow(
      "Telegram API error (getMe): HTTP 500",
    );
  });

  it("should retry on 429 rate limit and succeed", async () => {
    let callCount = 0;
    const handler = http.post(
      `https://api.telegram.org/bot${TEST_TOKEN}/sendMessage`,
      () => {
        callCount++;
        if (callCount === 1) {
          // retry_after must be > 0 to be truthy and trigger retry
          return HttpResponse.json(
            {
              ok: false,
              description: "Too Many Requests: retry after 0.001",
              parameters: { retry_after: 0.001 },
            },
            { status: 429 },
          );
        }
        return HttpResponse.json({
          ok: true,
          result: { message_id: 1, chat: { id: 42 }, text: "hello" },
        });
      },
    );
    server.use(handler.handler);

    const result = await callTelegramApi(TEST_TOKEN, "sendMessage", {
      chat_id: 42,
      text: "hello",
    });

    expect(result).toEqual({ message_id: 1, chat: { id: 42 }, text: "hello" });
    expect(callCount).toBe(2);
  });

  it("should throw after max retries on persistent 429", async () => {
    const handler = http.post(
      `https://api.telegram.org/bot${TEST_TOKEN}/sendMessage`,
      () => {
        return HttpResponse.json(
          {
            ok: false,
            description: "Too Many Requests: retry after 0.001",
            parameters: { retry_after: 0.001 },
          },
          { status: 429 },
        );
      },
    );
    server.use(handler.handler);

    await expect(
      callTelegramApi(TEST_TOKEN, "sendMessage", { chat_id: 42 }),
    ).rejects.toThrow("Telegram API error (sendMessage): Too Many Requests");

    // Should have been called 4 times (1 initial + 3 retries)
    expect(handler.mocked).toHaveBeenCalledTimes(4);
  });
});

describe("sendMessage", () => {
  it("should send a message with HTML parse mode", async () => {
    let capturedBody: unknown;
    const handler = http.post(
      `https://api.telegram.org/bot${TEST_TOKEN}/sendMessage`,
      async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          ok: true,
          result: { message_id: 99, chat: { id: 42 }, text: "hello" },
        });
      },
    );
    server.use(handler.handler);

    const client = createTelegramClient(TEST_TOKEN);
    const result = await sendMessage(client, 42, "hello");

    expect(result).toEqual({ message_id: 99, chat: { id: 42 }, text: "hello" });
    expect(capturedBody).toEqual({
      chat_id: 42,
      text: "hello",
      parse_mode: "HTML",
    });
  });

  it("should include reply_parameters when replyToMessageId is provided", async () => {
    let capturedBody: unknown;
    const handler = http.post(
      `https://api.telegram.org/bot${TEST_TOKEN}/sendMessage`,
      async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          ok: true,
          result: { message_id: 100, chat: { id: 42 } },
        });
      },
    );
    server.use(handler.handler);

    const client = createTelegramClient(TEST_TOKEN);
    await sendMessage(client, 42, "reply", { replyToMessageId: 50 });

    expect(capturedBody).toEqual({
      chat_id: 42,
      text: "reply",
      parse_mode: "HTML",
      reply_parameters: { message_id: 50 },
    });
  });

  it("should include reply_markup when provided", async () => {
    let capturedBody: unknown;
    const handler = http.post(
      `https://api.telegram.org/bot${TEST_TOKEN}/sendMessage`,
      async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          ok: true,
          result: { message_id: 101, chat: { id: 42 } },
        });
      },
    );
    server.use(handler.handler);

    const client = createTelegramClient(TEST_TOKEN);
    await sendMessage(client, 42, "connect", {
      replyMarkup: {
        inline_keyboard: [[{ text: "Connect", url: "https://example.com" }]],
      },
    });

    expect(capturedBody).toEqual({
      chat_id: 42,
      text: "connect",
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "Connect", url: "https://example.com" }]],
      },
    });
  });

  it("should convert raw markdown links before sending HTML", async () => {
    let capturedBody: unknown;
    const handler = http.post(
      `https://api.telegram.org/bot${TEST_TOKEN}/sendMessage`,
      async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          ok: true,
          result: { message_id: 102, chat: { id: 42 } },
        });
      },
    );
    server.use(handler.handler);

    const client = createTelegramClient(TEST_TOKEN);
    await sendMessage(
      client,
      42,
      [
        "Notion 还没有连接，需要先授权。",
        "",
        "请点击这个链接完成连接：",
        "[连接 Notion](https://tunnel-yuma-vm0-app.vm7.ai/connectors/notion/connect?agentId=b431c9a7-4f78-4977-aba1-dec4c04b212c)",
        "",
        '<a href="https://example.com/logs">📋 Audit</a>',
      ].join("\n"),
    );

    expect(capturedBody).toEqual({
      chat_id: 42,
      text: [
        "Notion 还没有连接，需要先授权。",
        "",
        "请点击这个链接完成连接：",
        '<a href="https://tunnel-yuma-vm0-app.vm7.ai/connectors/notion/connect?agentId=b431c9a7-4f78-4977-aba1-dec4c04b212c">连接 Notion</a>',
        "",
        '<a href="https://example.com/logs">📋 Audit</a>',
      ].join("\n"),
      parse_mode: "HTML",
    });
  });
});

describe("sendChatAction", () => {
  it("should send a chat action", async () => {
    let capturedBody: unknown;
    const handler = http.post(
      `https://api.telegram.org/bot${TEST_TOKEN}/sendChatAction`,
      async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ ok: true, result: true });
      },
    );
    server.use(handler.handler);

    const client = createTelegramClient(TEST_TOKEN);
    await sendChatAction(client, 42, "typing");

    expect(capturedBody).toEqual({
      chat_id: 42,
      action: "typing",
    });
  });
});

describe("editMessageText", () => {
  it("should edit a message with HTML parse mode", async () => {
    let capturedBody: unknown;
    const handler = http.post(
      `https://api.telegram.org/bot${TEST_TOKEN}/editMessageText`,
      async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          ok: true,
          result: { message_id: 99, chat: { id: 42 }, text: "edited" },
        });
      },
    );
    server.use(handler.handler);

    const client = createTelegramClient(TEST_TOKEN);
    const result = await editMessageText(client, 42, 99, "edited");

    expect(result).toEqual({
      message_id: 99,
      chat: { id: 42 },
      text: "edited",
    });
    expect(capturedBody).toEqual({
      chat_id: 42,
      message_id: 99,
      text: "edited",
      parse_mode: "HTML",
    });
  });

  it("should convert raw markdown links before editing HTML", async () => {
    let capturedBody: unknown;
    const handler = http.post(
      `https://api.telegram.org/bot${TEST_TOKEN}/editMessageText`,
      async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          ok: true,
          result: { message_id: 99, chat: { id: 42 }, text: "edited" },
        });
      },
    );
    server.use(handler.handler);

    const client = createTelegramClient(TEST_TOKEN);
    await editMessageText(
      client,
      42,
      99,
      "请先 [连接 Notion](https://example.com/connect?agentId=123)",
    );

    expect(capturedBody).toEqual({
      chat_id: 42,
      message_id: 99,
      text: '请先 <a href="https://example.com/connect?agentId=123">连接 Notion</a>',
      parse_mode: "HTML",
    });
  });
});

describe("deleteMessage", () => {
  it("should delete a message", async () => {
    let capturedBody: unknown;
    const handler = http.post(
      `https://api.telegram.org/bot${TEST_TOKEN}/deleteMessage`,
      async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ ok: true, result: true });
      },
    );
    server.use(handler.handler);

    const client = createTelegramClient(TEST_TOKEN);
    await deleteMessage(client, 42, 99);

    expect(capturedBody).toEqual({
      chat_id: 42,
      message_id: 99,
    });
  });
});

describe("getMe", () => {
  it("should return bot info", async () => {
    const handler = http.post(
      `https://api.telegram.org/bot${TEST_TOKEN}/getMe`,
      () => {
        return HttpResponse.json({
          ok: true,
          result: {
            id: 123,
            is_bot: true,
            first_name: "TestBot",
            username: "test_bot",
          },
        });
      },
    );
    server.use(handler.handler);

    const result = await getMe(TEST_TOKEN);

    expect(result).toEqual({
      id: 123,
      is_bot: true,
      first_name: "TestBot",
      username: "test_bot",
    });
  });
});

describe("setWebhook", () => {
  it("should register a webhook with allowed updates", async () => {
    let capturedBody: unknown;
    const handler = http.post(
      `https://api.telegram.org/bot${TEST_TOKEN}/setWebhook`,
      async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ ok: true, result: true });
      },
    );
    server.use(handler.handler);

    await setWebhook(TEST_TOKEN, "https://example.com/webhook", "my-secret");

    expect(capturedBody).toEqual({
      url: "https://example.com/webhook",
      secret_token: "my-secret",
      allowed_updates: ["message"],
    });
  });
});

describe("deleteWebhook", () => {
  it("should delete the webhook", async () => {
    const handler = http.post(
      `https://api.telegram.org/bot${TEST_TOKEN}/deleteWebhook`,
      () => {
        return HttpResponse.json({ ok: true, result: true });
      },
    );
    server.use(handler.handler);

    await expect(deleteWebhook(TEST_TOKEN)).resolves.toBeUndefined();
    expect(handler.mocked).toHaveBeenCalledTimes(1);
  });
});

describe("setMyCommands", () => {
  it("should register bot commands", async () => {
    let capturedBody: unknown;
    const handler = http.post(
      `https://api.telegram.org/bot${TEST_TOKEN}/setMyCommands`,
      async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ ok: true, result: true });
      },
    );
    server.use(handler.handler);

    const commands = [
      { command: "start", description: "Start the bot" },
      { command: "help", description: "Show help" },
    ];
    await setMyCommands(TEST_TOKEN, commands);

    expect(capturedBody).toEqual({ commands });
  });
});
