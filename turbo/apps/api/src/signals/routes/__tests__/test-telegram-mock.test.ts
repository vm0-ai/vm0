import { randomUUID } from "node:crypto";

import { TELEGRAM_E2E_FIXTURES } from "@vm0/core/telegram-e2e-fixtures";

import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv } from "../../../lib/env";
import { testContext } from "../../../__tests__/test-context";
import { testTelegramMockRoutes } from "../test-telegram-mock";

const context = testContext();

interface TelegramOkResponse {
  readonly ok: true;
  readonly result: unknown;
}

interface TelegramErrorResponse {
  readonly ok: false;
  readonly description: string;
}

interface TelegramMessageResult {
  readonly message_id: number;
  readonly chat: {
    readonly id: number;
  };
  readonly text?: string;
}

interface TelegramGetMeResult {
  readonly id: number;
  readonly is_bot: boolean;
  readonly first_name: string;
  readonly username: string;
}

interface TelegramFileResult {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly file_path: string;
}

function requestApp(path: string, init?: RequestInit): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testTelegramMockRoutes,
  });
  return Promise.resolve(app.request(path, init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function randomBotToken(): string {
  return `123456:${randomUUID()}`;
}

describe("POST /api/test/telegram-mock/:botToken/:method", () => {
  it("returns 404 when the test endpoint is not allowed", async () => {
    mockEnv("ENV", "production");
    const token = await randomBotToken();

    const response = await requestApp(
      `/api/test/telegram-mock/bot${token}/getMe`,
      { method: "POST" },
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("returns getMe fixture data", async () => {
    mockEnv("ENV", "development");
    const token = await randomBotToken();

    const response = await requestApp(
      `/api/test/telegram-mock/bot${token}/getMe`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    const body = await readJson<TelegramOkResponse>(response);
    expect(body.ok).toBeTruthy();
    expect(body.result).toStrictEqual({
      id: Number(TELEGRAM_E2E_FIXTURES.botId),
      is_bot: true,
      first_name: "VM0 E2E",
      username: TELEGRAM_E2E_FIXTURES.botUsername,
    } satisfies TelegramGetMeResult);
  });

  it("returns sendMessage data from a JSON body", async () => {
    mockEnv("ENV", "development");
    const token = await randomBotToken();
    const requestBody = { chat_id: "990010", text: "hello telegram" };

    const response = await requestApp(
      `/api/test/telegram-mock/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      },
    );

    expect(response.status).toBe(200);
    const body = await readJson<TelegramOkResponse>(response);
    const result = body.result as TelegramMessageResult;
    expect(result.chat.id).toBe(990_010);
    expect(result.text).toBe("hello telegram");
    expect(typeof result.message_id).toBe("number");
  });

  it("returns editMessageText data with a numeric chat id", async () => {
    mockEnv("ENV", "development");
    const token = await randomBotToken();

    const response = await requestApp(
      `/api/test/telegram-mock/bot${token}/editMessageText`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: 990_011, text: "updated" }),
      },
    );

    expect(response.status).toBe(200);
    const body = await readJson<TelegramOkResponse>(response);
    const result = body.result as TelegramMessageResult;
    expect(result.chat.id).toBe(990_011);
    expect(result.text).toBe("updated");
  });

  it.each([
    "sendChatAction",
    "deleteMessage",
    "deleteWebhook",
    "setWebhook",
    "setMyCommands",
  ])("returns true for %s", async (method) => {
    mockEnv("ENV", "development");
    const token = await randomBotToken();

    const response = await requestApp(
      `/api/test/telegram-mock/bot${token}/${method}`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    await expect(readJson<TelegramOkResponse>(response)).resolves.toStrictEqual(
      {
        ok: true,
        result: true,
      },
    );
  });

  it("returns getFile data with requested file id", async () => {
    mockEnv("ENV", "development");
    const token = await randomBotToken();

    const response = await requestApp(
      `/api/test/telegram-mock/bot${token}/getFile`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: "custom-file" }),
      },
    );

    expect(response.status).toBe(200);
    const body = await readJson<TelegramOkResponse>(response);
    expect(body.result).toStrictEqual({
      file_id: "custom-file",
      file_unique_id: "e2e-file-unique",
      file_path: "photos/e2e-file.jpg",
    } satisfies TelegramFileResult);
  });

  it("returns Telegram-style 404 for unsupported methods", async () => {
    mockEnv("ENV", "development");
    const token = await randomBotToken();

    const response = await requestApp(
      `/api/test/telegram-mock/bot${token}/answerCallbackQuery`,
      { method: "POST" },
    );

    expect(response.status).toBe(404);
    await expect(
      readJson<TelegramErrorResponse>(response),
    ).resolves.toStrictEqual({
      ok: false,
      description: "Unsupported mock method: answerCallbackQuery",
    });
  });

  it("accepts invalid JSON for supported methods", async () => {
    mockEnv("ENV", "development");
    const token = await randomBotToken();

    const response = await requestApp(
      `/api/test/telegram-mock/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not-json",
      },
    );

    expect(response.status).toBe(200);
    const body = await readJson<TelegramOkResponse>(response);
    const result = body.result as TelegramMessageResult;
    expect(result.chat.id).toBe(Number(TELEGRAM_E2E_FIXTURES.chatId));
    expect(result.text).toBeUndefined();
  });

  it("uses the fixture chat id for non-object JSON values", async () => {
    mockEnv("ENV", "development");
    const token = await randomBotToken();

    const response = await requestApp(
      `/api/test/telegram-mock/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(["not", "an", "object"]),
      },
    );

    expect(response.status).toBe(200);
    const body = await readJson<TelegramOkResponse>(response);
    const result = body.result as TelegramMessageResult;
    expect(result.chat.id).toBe(Number(TELEGRAM_E2E_FIXTURES.chatId));
    expect(result.text).toBeUndefined();
  });
});
