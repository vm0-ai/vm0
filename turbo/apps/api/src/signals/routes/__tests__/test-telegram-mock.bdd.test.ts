import { randomUUID } from "node:crypto";

import { testTelegramMockContract } from "@vm0/api-contracts/contracts/test-telegram-mock";
import {
  testTelegramStateContract,
  type TestTelegramStateResponse,
} from "@vm0/api-contracts/contracts/test-telegram-state";
import { TELEGRAM_E2E_FIXTURES } from "@vm0/core/telegram-e2e-fixtures";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";

const context = testContext();
const BASE_ROUTE = "/api/test/telegram-mock";
const TELEGRAM_MOCK_NOW_ISO = "2026-06-10T12:34:56.789Z";

function telegramMockClient() {
  return setupApp({ context })(testTelegramMockContract);
}

function telegramStateClient() {
  return setupApp({ context })(testTelegramStateContract);
}

function randomBotToken(): string {
  return `123456:${randomUUID()}`;
}

function prefixedBotToken(token: string): string {
  return `bot${token}`;
}

async function rawRequest(path: string, init?: RequestInit): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return await app.request(path, init);
}

async function readRawJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function jsonHeaders(): HeadersInit {
  return { "content-type": "application/json" };
}

function mockCallFor(
  state: TestTelegramStateResponse,
  predicate: (call: TestTelegramStateResponse["mock_calls"][number]) => boolean,
): TestTelegramStateResponse["mock_calls"][number] {
  const call = state.mock_calls.find(predicate);
  if (!call) {
    throw new Error("Expected Telegram mock call in state diagnostics");
  }
  return call;
}

function expectNoMockCallFor(
  state: TestTelegramStateResponse,
  botToken: string,
): void {
  expect(
    state.mock_calls.some((call) => {
      return call.botToken === botToken;
    }),
  ).toBeFalsy();
}

function expectMessageResult(
  result: unknown,
  expected: {
    readonly chatId: number;
    readonly messageId: number;
    readonly text?: string;
  },
): void {
  if (expected.text === undefined) {
    expect(result).toMatchObject({
      message_id: expected.messageId,
      chat: { id: expected.chatId },
    });
    return;
  }

  expect(result).toMatchObject({
    message_id: expected.messageId,
    chat: { id: expected.chatId },
    text: expected.text,
  });
}

async function stateFor(botToken: string): Promise<TestTelegramStateResponse> {
  const state = await accept(
    telegramStateClient().get({ query: { bot_id: botToken } }),
    [200],
  );
  return state.body;
}

function rawTelegramMock(
  botToken: string,
  method: string,
  body: string,
): Promise<Response> {
  return rawRequest(`${BASE_ROUTE}/${prefixedBotToken(botToken)}/${method}`, {
    method: "POST",
    headers: jsonHeaders(),
    body,
  });
}

describe("/api/test/telegram-mock/:botToken/:method BDD", () => {
  it("hides the Telegram mock endpoint outside allowed test environments", async () => {
    mockEnv("ENV", "production");
    const botToken = randomBotToken();

    const hidden = await accept(
      telegramMockClient().post({
        params: { botToken: prefixedBotToken(botToken), method: "getMe" },
        body: undefined,
      }),
      [404],
    );

    expect(hidden.body).toBe("Not found");

    mockEnv("ENV", "development");
    expectNoMockCallFor(await stateFor(botToken), botToken);
  });

  it("serves fixture responses and records supported method calls through state API", async () => {
    mockEnv("ENV", "development");
    const botToken = randomBotToken();
    const client = telegramMockClient();

    const getMe = await accept(
      client.post({
        params: { botToken: prefixedBotToken(botToken), method: "getMe" },
        body: undefined,
      }),
      [200],
    );

    expect(getMe.body.result).toStrictEqual({
      id: Number(TELEGRAM_E2E_FIXTURES.botId),
      is_bot: true,
      first_name: "VM0 E2E",
      username: TELEGRAM_E2E_FIXTURES.botUsername,
    });

    for (const method of [
      "sendChatAction",
      "deleteMessage",
      "deleteWebhook",
      "setWebhook",
      "setMyCommands",
    ]) {
      const response = await accept(
        client.post({
          params: { botToken: prefixedBotToken(botToken), method },
          body: undefined,
        }),
        [200],
      );

      expect(response.body).toStrictEqual({ ok: true, result: true });
    }

    const getFile = await accept(
      client.post({
        params: { botToken: prefixedBotToken(botToken), method: "getFile" },
        body: { file_id: "custom-file" },
      }),
      [200],
    );
    const unsupported = await accept(
      client.post({
        params: {
          botToken: prefixedBotToken(botToken),
          method: "answerCallbackQuery",
        },
        body: undefined,
      }),
      [404],
    );

    expect(getFile.body.result).toStrictEqual({
      file_id: "custom-file",
      file_unique_id: "e2e-file-unique",
      file_path: "photos/e2e-file.jpg",
    });
    expect(unsupported.body).toStrictEqual({
      ok: false,
      description: "Unsupported mock method: answerCallbackQuery",
    });

    const state = await stateFor(botToken);
    const getMeCall = mockCallFor(state, (call) => {
      return call.method === "getMe" && call.botToken === botToken;
    });
    const getFileCall = mockCallFor(state, (call) => {
      return call.method === "getFile" && call.botToken === botToken;
    });
    const unsupportedCall = mockCallFor(state, (call) => {
      return (
        call.method === "answerCallbackQuery" && call.botToken === botToken
      );
    });

    expect(getMeCall).toMatchObject({
      botToken,
      chatId: null,
      body: "",
      bodyJson: null,
    });
    expect(getFileCall.bodyJson).toStrictEqual({ file_id: "custom-file" });
    expect(unsupportedCall).toMatchObject({
      method: "answerCallbackQuery",
      botToken,
      body: "",
      bodyJson: null,
    });
  });

  it("parses message bodies and exposes raw body diagnostics through state API", async () => {
    mockEnv("ENV", "development");
    const mockNowDate = new Date(TELEGRAM_MOCK_NOW_ISO);
    const expectedMessageId = Math.floor(mockNowDate.getTime() % 1_000_000_000);
    mockNow(mockNowDate);
    const botToken = randomBotToken();

    const sendBody = JSON.stringify({
      chat_id: "990010",
      text: "hello telegram",
    });
    const sendMessageResponse = await rawTelegramMock(
      botToken,
      "sendMessage",
      sendBody,
    );
    const sendMessage = await readRawJson<{
      readonly ok: true;
      readonly result: unknown;
    }>(sendMessageResponse);

    expect(sendMessageResponse.status).toBe(200);
    expectMessageResult(sendMessage.result, {
      chatId: 990_010,
      messageId: expectedMessageId,
      text: "hello telegram",
    });

    const editBody = JSON.stringify({ chat_id: 990_011, text: "updated" });
    const editResponse = await rawTelegramMock(
      botToken,
      "editMessageText",
      editBody,
    );
    const edit = await readRawJson<{
      readonly ok: true;
      readonly result: unknown;
    }>(editResponse);

    expect(editResponse.status).toBe(200);
    expectMessageResult(edit.result, {
      chatId: 990_011,
      messageId: expectedMessageId,
      text: "updated",
    });

    const invalidResponse = await rawTelegramMock(
      botToken,
      "sendMessage",
      "{not-json",
    );
    const invalid = await readRawJson<{
      readonly ok: true;
      readonly result: unknown;
    }>(invalidResponse);

    expect(invalidResponse.status).toBe(200);
    expectMessageResult(invalid.result, {
      chatId: Number(TELEGRAM_E2E_FIXTURES.chatId),
      messageId: expectedMessageId,
    });

    const arrayBody = JSON.stringify(["not", "an", "object"]);
    const arrayResponse = await rawTelegramMock(
      botToken,
      "sendMessage",
      arrayBody,
    );
    const array = await readRawJson<{
      readonly ok: true;
      readonly result: unknown;
    }>(arrayResponse);

    expect(arrayResponse.status).toBe(200);
    expectMessageResult(array.result, {
      chatId: Number(TELEGRAM_E2E_FIXTURES.chatId),
      messageId: expectedMessageId,
    });

    const state = await stateFor(botToken);
    const sendCall = mockCallFor(state, (call) => {
      return call.method === "sendMessage" && call.body === sendBody;
    });
    const editCall = mockCallFor(state, (call) => {
      return call.method === "editMessageText" && call.body === editBody;
    });
    const invalidCall = mockCallFor(state, (call) => {
      return call.method === "sendMessage" && call.body === "{not-json";
    });
    const arrayCall = mockCallFor(state, (call) => {
      return call.method === "sendMessage" && call.body === arrayBody;
    });

    expect(sendCall).toMatchObject({
      botToken,
      chatId: "990010",
      body: sendBody,
      bodyJson: { chat_id: "990010", text: "hello telegram" },
    });
    expect(editCall).toMatchObject({
      botToken,
      chatId: "990011",
      body: editBody,
      bodyJson: { chat_id: 990_011, text: "updated" },
    });
    expect(invalidCall).toMatchObject({
      botToken,
      chatId: null,
      body: "{not-json",
      bodyJson: null,
    });
    expect(arrayCall).toMatchObject({
      botToken,
      chatId: null,
      body: arrayBody,
      bodyJson: ["not", "an", "object"],
    });
  });
});
