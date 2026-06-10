import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { desc, eq } from "drizzle-orm";

import { TELEGRAM_E2E_FIXTURES } from "@vm0/core/telegram-e2e-fixtures";
import { e2eTelegramMockCallLog } from "@vm0/db/schema/e2e-telegram-mock-call-log";

import { createApp } from "../../../app-factory";
import { mockEnv } from "../../../lib/env";
import { testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { createFixtureTracker } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();

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

interface MockCallRow {
  readonly method: string;
  readonly botToken: string | null;
  readonly chatId: string | null;
  readonly body: string;
  readonly bodyJson: unknown;
}

function requestApp(path: string, init?: RequestInit): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return Promise.resolve(app.request(path, init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function latestCall(botToken: string): Promise<MockCallRow | null> {
  const writeDb = store.set(writeDb$);
  const [row] = await writeDb
    .select({
      method: e2eTelegramMockCallLog.method,
      botToken: e2eTelegramMockCallLog.botToken,
      chatId: e2eTelegramMockCallLog.chatId,
      body: e2eTelegramMockCallLog.body,
      bodyJson: e2eTelegramMockCallLog.bodyJson,
    })
    .from(e2eTelegramMockCallLog)
    .where(eq(e2eTelegramMockCallLog.botToken, botToken))
    .orderBy(desc(e2eTelegramMockCallLog.createdAt))
    .limit(1);
  return row ?? null;
}

async function cleanupMockCallToken(token: string): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .delete(e2eTelegramMockCallLog)
    .where(eq(e2eTelegramMockCallLog.botToken, token));
}

const trackMockCallToken = createFixtureTracker(cleanupMockCallToken);

function randomBotToken(): Promise<string> {
  return trackMockCallToken(Promise.resolve(`123456:${randomUUID()}`));
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
    await expect(latestCall(token)).resolves.toBeNull();
  });

  it("returns getMe fixture data and logs a stripped bot token", async () => {
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
    await expect(latestCall(token)).resolves.toMatchObject({
      method: "getMe",
      botToken: token,
      chatId: null,
      body: "",
      bodyJson: null,
    });
  });

  it("returns sendMessage data and stores raw and parsed body JSON", async () => {
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
    await expect(latestCall(token)).resolves.toMatchObject({
      method: "sendMessage",
      botToken: token,
      chatId: "990010",
      body: JSON.stringify(requestBody),
      bodyJson: requestBody,
    });
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
    await expect(latestCall(token)).resolves.toMatchObject({
      method: "editMessageText",
      botToken: token,
      chatId: "990011",
    });
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
    await expect(latestCall(token)).resolves.toMatchObject({
      method,
      botToken: token,
    });
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
    await expect(latestCall(token)).resolves.toMatchObject({
      method: "answerCallbackQuery",
      botToken: token,
    });
  });

  it("accepts invalid JSON for supported methods and logs null body JSON", async () => {
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
    await expect(latestCall(token)).resolves.toMatchObject({
      method: "sendMessage",
      botToken: token,
      chatId: null,
      body: "{not-json",
      bodyJson: null,
    });
  });

  it("logs parsed non-object JSON values while using the fixture chat id", async () => {
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
    await expect(latestCall(token)).resolves.toMatchObject({
      method: "sendMessage",
      botToken: token,
      chatId: null,
      body: JSON.stringify(["not", "an", "object"]),
      bodyJson: ["not", "an", "object"],
    });
  });
});
