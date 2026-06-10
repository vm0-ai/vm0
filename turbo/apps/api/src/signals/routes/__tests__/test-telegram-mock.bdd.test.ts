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

// BDD migration of the legacy `test-telegram-mock.test.ts`.
// The 9 legacy `it()`s (incl. it.each 5 cases) collapse into
// 2 BDD `it()`s: (1) auth + happy-path chain (404 prod env
// → 200 getMe fixture data + DB log → 200 sendMessage +
// DB log stores raw + parsed JSON → 200 editMessageText +
// numeric chat id → 200 it.each 5 cases (sendChatAction,
// deleteMessage, deleteWebhook, setWebhook, setMyCommands)
// → 200 getFile with requested file id), (2) error + edge
// chain (404 Telegram-style for unsupported method + DB log
// → 200 accepts invalid JSON + DB log stores null body JSON
// → 200 logs parsed non-object JSON values + DB log).
//
// Service-Level Exception: `e2eTelegramMockCallLog` rows
// are read directly via `writeDb$` because no public GET
// endpoint exists for a single mock call log.

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

describe("BDD POST /api/test/telegram-mock/:botToken/:method — 200 happy-path chain", () => {
  it("gwt-wt-wt: 404 prod env → 200 getMe fixture data + DB log → 200 sendMessage + DB log stores raw + parsed JSON → 200 editMessageText with numeric chat id → 200 it.each 5 cases (sendChatAction, deleteMessage, deleteWebhook, setWebhook, setMyCommands) → 200 getFile with requested file id", async () => {
    // Given: production env + a bot token.
    mockEnv("ENV", "production");
    const prodToken = await randomBotToken();

    // When + Then: 404 — the test endpoint is not allowed in
    // production.
    const prodResponse = await requestApp(
      `/api/test/telegram-mock/bot${prodToken}/getMe`,
      { method: "POST" },
    );
    expect(prodResponse.status).toBe(404);
    await expect(prodResponse.text()).resolves.toBe("Not found");
    await expect(latestCall(prodToken)).resolves.toBeNull();

    // Given: development env + a bot token.
    mockEnv("ENV", "development");
    const getMeToken = await randomBotToken();

    // When + Then: 200 — getMe returns the fixture bot data
    // and the call is logged.
    const getMeResponse = await requestApp(
      `/api/test/telegram-mock/bot${getMeToken}/getMe`,
      { method: "POST" },
    );
    expect(getMeResponse.status).toBe(200);
    const getMeBody = await readJson<TelegramOkResponse>(getMeResponse);
    expect(getMeBody.ok).toBeTruthy();
    expect(getMeBody.result).toStrictEqual({
      id: Number(TELEGRAM_E2E_FIXTURES.botId),
      is_bot: true,
      first_name: "VM0 E2E",
      username: TELEGRAM_E2E_FIXTURES.botUsername,
    } satisfies TelegramGetMeResult);
    await expect(latestCall(getMeToken)).resolves.toMatchObject({
      method: "getMe",
      botToken: getMeToken,
      chatId: null,
      body: "",
      bodyJson: null,
    });

    // Given: a fresh sendMessage token.
    const sendMessageToken = await randomBotToken();
    const sendMessageBody = { chat_id: "990010", text: "hello telegram" };

    // When + Then: 200 — sendMessage returns the result +
    // the DB log stores raw + parsed JSON.
    const sendMessageResponse = await requestApp(
      `/api/test/telegram-mock/bot${sendMessageToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sendMessageBody),
      },
    );
    expect(sendMessageResponse.status).toBe(200);
    const sendMessageResult = (
      await readJson<TelegramOkResponse>(sendMessageResponse)
    ).result as TelegramMessageResult;
    expect(sendMessageResult.chat.id).toBe(990_010);
    expect(sendMessageResult.text).toBe("hello telegram");
    expect(typeof sendMessageResult.message_id).toBe("number");
    await expect(latestCall(sendMessageToken)).resolves.toMatchObject({
      method: "sendMessage",
      botToken: sendMessageToken,
      chatId: "990010",
      body: JSON.stringify(sendMessageBody),
      bodyJson: sendMessageBody,
    });

    // Given: a fresh editMessageText token with a numeric
    // chat id.
    const editToken = await randomBotToken();

    // When + Then: 200 — editMessageText echoes the numeric
    // chat id + text in the response.
    const editResponse = await requestApp(
      `/api/test/telegram-mock/bot${editToken}/editMessageText`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: 990_011, text: "updated" }),
      },
    );
    expect(editResponse.status).toBe(200);
    const editResult = (await readJson<TelegramOkResponse>(editResponse))
      .result as TelegramMessageResult;
    expect(editResult.chat.id).toBe(990_011);
    expect(editResult.text).toBe("updated");
    await expect(latestCall(editToken)).resolves.toMatchObject({
      method: "editMessageText",
      botToken: editToken,
      chatId: "990011",
    });

    // Given: 5 fresh tokens for the simple
    // `{ ok: true, result: true }` methods.
    for (const method of [
      "sendChatAction",
      "deleteMessage",
      "deleteWebhook",
      "setWebhook",
      "setMyCommands",
    ]) {
      const token = await randomBotToken();
      const response = await requestApp(
        `/api/test/telegram-mock/bot${token}/${method}`,
        { method: "POST" },
      );

      // When + Then: 200 + the response is `{ ok: true,
      // result: true }` and the call is logged.
      expect(response.status).toBe(200);
      await expect(
        readJson<TelegramOkResponse>(response),
      ).resolves.toStrictEqual({ ok: true, result: true });
      await expect(latestCall(token)).resolves.toMatchObject({
        method,
        botToken: token,
      });
    }

    // Given: a fresh getFile token with a `file_id`.
    const getFileToken = await randomBotToken();

    // When + Then: 200 — getFile echoes the requested file id
    // with the fixture's `file_unique_id` + `file_path`.
    const getFileResponse = await requestApp(
      `/api/test/telegram-mock/bot${getFileToken}/getFile`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: "custom-file" }),
      },
    );
    expect(getFileResponse.status).toBe(200);
    expect(
      (await readJson<TelegramOkResponse>(getFileResponse)).result,
    ).toStrictEqual({
      file_id: "custom-file",
      file_unique_id: "e2e-file-unique",
      file_path: "photos/e2e-file.jpg",
    } satisfies TelegramFileResult);
  });
});

describe("BDD POST /api/test/telegram-mock/:botToken/:method — 404 error + 200 edge chain", () => {
  it("gwt-wt-wt: 404 Telegram-style for unsupported method + DB log → 200 accepts invalid JSON + DB log stores null body JSON → 200 logs parsed non-object JSON values + DB log", async () => {
    // Given: development env + a fresh token.
    mockEnv("ENV", "development");
    const unsupportedToken = await randomBotToken();

    // When + Then: 404 — the unsupported method returns a
    // Telegram-style error body and is still logged.
    const unsupportedResponse = await requestApp(
      `/api/test/telegram-mock/bot${unsupportedToken}/answerCallbackQuery`,
      { method: "POST" },
    );
    expect(unsupportedResponse.status).toBe(404);
    await expect(
      readJson<TelegramErrorResponse>(unsupportedResponse),
    ).resolves.toStrictEqual({
      ok: false,
      description: "Unsupported mock method: answerCallbackQuery",
    });
    await expect(latestCall(unsupportedToken)).resolves.toMatchObject({
      method: "answerCallbackQuery",
      botToken: unsupportedToken,
    });

    // Given: a fresh sendMessage token + a non-JSON body.
    const invalidJsonToken = await randomBotToken();

    // When + Then: 200 — the request still succeeds with
    // the fixture chat id + DB log stores null body JSON.
    const invalidJsonResponse = await requestApp(
      `/api/test/telegram-mock/bot${invalidJsonToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not-json",
      },
    );
    expect(invalidJsonResponse.status).toBe(200);
    const invalidJsonResult = (
      await readJson<TelegramOkResponse>(invalidJsonResponse)
    ).result as TelegramMessageResult;
    expect(invalidJsonResult.chat.id).toBe(
      Number(TELEGRAM_E2E_FIXTURES.chatId),
    );
    expect(invalidJsonResult.text).toBeUndefined();
    await expect(latestCall(invalidJsonToken)).resolves.toMatchObject({
      method: "sendMessage",
      botToken: invalidJsonToken,
      chatId: null,
      body: "{not-json",
      bodyJson: null,
    });

    // Given: a fresh sendMessage token + a non-object JSON
    // array body.
    const arrayToken = await randomBotToken();

    // When + Then: 200 — the request still succeeds with
    // the fixture chat id + DB log stores the array as
    // parsed body JSON.
    const arrayResponse = await requestApp(
      `/api/test/telegram-mock/bot${arrayToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(["not", "an", "object"]),
      },
    );
    expect(arrayResponse.status).toBe(200);
    const arrayResult = (await readJson<TelegramOkResponse>(arrayResponse))
      .result as TelegramMessageResult;
    expect(arrayResult.chat.id).toBe(Number(TELEGRAM_E2E_FIXTURES.chatId));
    expect(arrayResult.text).toBeUndefined();
    await expect(latestCall(arrayToken)).resolves.toMatchObject({
      method: "sendMessage",
      botToken: arrayToken,
      chatId: null,
      body: JSON.stringify(["not", "an", "object"]),
      bodyJson: ["not", "an", "object"],
    });
  });
});
