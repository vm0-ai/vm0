import { randomUUID } from "node:crypto";

import {
  OFFICIAL_TELEGRAM_BOT_ID,
  zeroIntegrationsTelegramContract,
} from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import type {
  TestTelegramStateActionBody,
  TestTelegramStateActionResponse,
  TestTelegramStateResponse,
} from "@vm0/api-contracts/contracts/test-telegram-state";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { clearMockedEnv, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

const TEST_BOT_TOKEN = "123456:test-bot-token";
const NEW_BOT_TOKEN = "123456:new-test-bot-token";
const OFFICIAL_BOT_TOKEN = "987654:official-bot-token";
const OFFICIAL_BOT_USERNAME = "official_zero_bot";
const OFFICIAL_WEBHOOK_SECRET = "official-webhook-secret";
const CALLBACK_SECRET = "test-callback-secret";
const TELEGRAM_STATE_ACTION_ROUTE = "/api/test/telegram-state/action";
const TELEGRAM_STATE_ROUTE = "/api/test/telegram-state";
const TELEGRAM_CALLBACK_ROUTE = "/api/internal/callbacks/telegram";

interface TelegramPostFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly versionId: string;
  readonly telegramBotId: string;
  readonly webhookSecret: string;
  readonly telegramUserId?: string;
}

interface TelegramSendMessageBody {
  readonly chat_id: string | number;
  readonly text: string;
  readonly parse_mode?: string;
  readonly reply_parameters?: { readonly message_id: number };
  readonly reply_markup?: {
    readonly inline_keyboard: readonly (readonly {
      readonly text: string;
      readonly url: string;
    }[])[];
  };
}

function newTelegramBotId(): string {
  return String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000);
}

function telegramOauthHead(contentLength: string, expectedOrigin?: string) {
  return http.head("https://oauth.telegram.org/auth", ({ request }) => {
    const url = new URL(request.url);
    if (expectedOrigin) {
      expect(url.searchParams.get("origin")).toBe(expectedOrigin);
    }
    return new HttpResponse(null, {
      headers: { "content-length": contentLength },
    });
  });
}

function mockTelegramGetMe(args: {
  readonly botId: string;
  readonly username?: string;
  readonly privacyDisabled?: boolean;
}): void {
  context.mocks.telegram.getMe.mockResolvedValue({
    id: Number(args.botId),
    username: args.username ?? `bot_${args.botId}`,
    first_name: "Test Bot",
    can_read_all_group_messages: args.privacyDisabled ?? true,
  });
}

function configureOfficialBotEnv(): void {
  mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", OFFICIAL_BOT_TOKEN);
  mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", OFFICIAL_BOT_USERNAME);
  mockEnv("TELEGRAM_OFFICIAL_WEBHOOK_SECRET", OFFICIAL_WEBHOOK_SECRET);
}

function telegramApiMocks(token = TEST_BOT_TOKEN): {
  readonly chatActions: unknown[];
  readonly sentMessages: TelegramSendMessageBody[];
} {
  const chatActions: unknown[] = [];
  const sentMessages: TelegramSendMessageBody[] = [];
  let nextMessageId = 700;

  server.use(
    http.post(
      `https://api.telegram.org/bot${token}/sendChatAction`,
      async ({ request }) => {
        chatActions.push(await request.json());
        return HttpResponse.json({ ok: true, result: true });
      },
    ),
    http.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      async ({ request }) => {
        const body = (await request.json()) as TelegramSendMessageBody;
        sentMessages.push(body);
        return HttpResponse.json({
          ok: true,
          result: {
            message_id: nextMessageId++,
            chat: { id: Number(body.chat_id) || 123 },
            text: body.text,
          },
        });
      },
    ),
  );

  return { chatActions, sentMessages };
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function expectOk(response: Response, operation: string): void {
  if (response.ok) {
    return;
  }
  throw new Error(`${operation} failed with ${response.status}`);
}

async function postTelegramStateAction(
  body: TestTelegramStateActionBody,
): Promise<TestTelegramStateActionResponse> {
  const response = await createApp({ signal: context.signal }).request(
    TELEGRAM_STATE_ACTION_ROUTE,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  await expectOk(response, `telegram state action ${body.action}`);
  return await readJson<TestTelegramStateActionResponse>(response);
}

async function readTelegramState(
  botId: string,
): Promise<TestTelegramStateResponse> {
  const response = await createApp({ signal: context.signal }).request(
    `${TELEGRAM_STATE_ROUTE}?bot_id=${encodeURIComponent(botId)}`,
  );
  await expectOk(response, "read telegram state");
  return await readJson<TestTelegramStateResponse>(response);
}

function signedHeaders(rawBody: string): Record<string, string> {
  const timestamp = Math.floor(now() / 1000);
  return {
    "content-type": "application/json",
    "x-vm0-signature": computeHmacSignature(
      rawBody,
      CALLBACK_SECRET,
      timestamp,
    ),
    "x-vm0-timestamp": String(timestamp),
  };
}

async function postTelegramCallback(body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  const response = await createApp({ signal: context.signal }).request(
    TELEGRAM_CALLBACK_ROUTE,
    {
      method: "POST",
      headers: signedHeaders(rawBody),
      body: rawBody,
    },
  );
  await expectOk(response, "telegram callback");
  return await readJson<{ readonly success: true }>(response);
}

async function seedTelegramPostFixture(
  args: {
    readonly orgId?: string;
    readonly userId?: string;
    readonly telegramBotId?: string;
    readonly installBot?: boolean;
    readonly linkTelegramUser?: boolean;
    readonly seedOfficialLink?: boolean;
    readonly seedDefaultAgent?: boolean;
  } = {},
): Promise<TelegramPostFixture> {
  const response = await postTelegramStateAction({
    action: "seed-post-fixture",
    org_id: args.orgId,
    user_id: args.userId,
    telegram_bot_id: args.telegramBotId,
    install_bot: args.installBot,
    link_telegram_user: args.linkTelegramUser,
    seed_official_link: args.seedOfficialLink,
    seed_default_agent: args.seedDefaultAgent,
    bot_token: TEST_BOT_TOKEN,
  });
  const fixture =
    typeof response.fixture === "object" && response.fixture !== null
      ? (response.fixture as Record<string, unknown>)
      : null;
  if (!fixture) {
    throw new Error("seedTelegramPostFixture: response missing fixture");
  }
  return {
    orgId: String(fixture.org_id),
    userId: String(fixture.user_id),
    composeId: String(fixture.compose_id),
    versionId: String(fixture.version_id),
    telegramBotId: String(fixture.telegram_bot_id),
    webhookSecret: String(fixture.webhook_secret),
    telegramUserId:
      typeof fixture.telegram_user_id === "string"
        ? fixture.telegram_user_id
        : undefined,
  };
}

async function deleteTelegramPostFixture(
  fixture: TelegramPostFixture,
): Promise<void> {
  await postTelegramStateAction({
    action: "delete-post-fixture",
    org_id: fixture.orgId,
    user_id: fixture.userId,
    compose_id: fixture.composeId,
    telegram_bot_id: fixture.telegramBotId,
  });
}

const trackFixture = createFixtureTracker<TelegramPostFixture>(
  deleteTelegramPostFixture,
);

beforeEach(() => {
  context.mocks.s3.send.mockResolvedValue({});
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  server.use(telegramOauthHead("1001"));
});

afterEach(() => {
  clearMockedEnv();
});

function telegramClient() {
  return setupApp({ context })(zeroIntegrationsTelegramContract);
}

async function postRegisterRaw(body: unknown): Promise<Response> {
  return await createApp({ signal: context.signal }).request(
    "/api/telegram/register",
    {
      method: "POST",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

async function postWebhook(args: {
  readonly telegramBotId: string;
  readonly secret: string;
  readonly body: unknown;
}): Promise<Response> {
  return await createApp({ signal: context.signal }).request(
    `/api/telegram/webhook/${args.telegramBotId}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": args.secret,
      },
      body:
        typeof args.body === "string" ? args.body : JSON.stringify(args.body),
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredStringField(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new Error(`Expected ${field} to be a string`);
  }
  return value;
}

function nullableStringField(
  record: Record<string, unknown>,
  field: string,
): string | null {
  const value = record[field];
  return typeof value === "string" ? value : null;
}

function stateRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function stateRecords(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}

interface TelegramRunSnapshot {
  readonly id: string;
  readonly status: string | null;
  readonly error: string | null;
  readonly prompt: string | null;
  readonly appendSystemPrompt: string | null;
  readonly continuedFromSessionId: string | null;
  readonly sessionId: string | null;
}

interface TelegramZeroRunSnapshot {
  readonly id: string;
  readonly triggerSource: string | null;
  readonly modelProvider: string | null;
  readonly selectedModel: string | null;
}

interface TelegramCallbackSnapshot {
  readonly id: string;
  readonly url: string | null;
  readonly internalKind: string | null;
  readonly payload: unknown;
  readonly status: string | null;
}

interface TelegramPostRunState {
  readonly run: TelegramRunSnapshot | null;
  readonly zeroRun: TelegramZeroRunSnapshot | null;
  readonly callbacks: readonly TelegramCallbackSnapshot[];
  readonly jobExists: boolean;
}

function runSnapshot(value: unknown): TelegramRunSnapshot | null {
  const record = stateRecord(value);
  if (!record) {
    return null;
  }
  return {
    id: requiredStringField(record, "id"),
    status: nullableStringField(record, "status"),
    error: nullableStringField(record, "error"),
    prompt: nullableStringField(record, "prompt"),
    appendSystemPrompt: nullableStringField(record, "appendSystemPrompt"),
    continuedFromSessionId: nullableStringField(
      record,
      "continuedFromSessionId",
    ),
    sessionId: nullableStringField(record, "sessionId"),
  };
}

function zeroRunSnapshot(value: unknown): TelegramZeroRunSnapshot | null {
  const record = stateRecord(value);
  if (!record) {
    return null;
  }
  return {
    id: requiredStringField(record, "id"),
    triggerSource: nullableStringField(record, "triggerSource"),
    modelProvider: nullableStringField(record, "modelProvider"),
    selectedModel: nullableStringField(record, "selectedModel"),
  };
}

function callbackSnapshot(value: unknown): TelegramCallbackSnapshot {
  const record = stateRecord(value);
  if (!record) {
    throw new Error("Expected callback state to be an object");
  }
  return {
    id: requiredStringField(record, "id"),
    url: nullableStringField(record, "url"),
    internalKind: nullableStringField(record, "internalKind"),
    payload: record.payload,
    status: nullableStringField(record, "status"),
  };
}

async function telegramPostRunState(
  fixture: TelegramPostFixture,
  prompt?: string,
): Promise<TelegramPostRunState> {
  const response = await postTelegramStateAction({
    action: "get-post-run-state",
    org_id: fixture.orgId,
    user_id: fixture.userId,
    prompt,
  });

  return {
    run: runSnapshot(response.run),
    zeroRun: zeroRunSnapshot(response.zero_run),
    callbacks: stateRecords(response.callbacks).map(callbackSnapshot),
    jobExists: response.job_exists === true,
  };
}

async function latestRunForFixture(
  fixture: TelegramPostFixture,
): Promise<TelegramRunSnapshot | null> {
  return (await telegramPostRunState(fixture)).run;
}

function sandboxOperationEventsForRun(
  runId: string,
): readonly Record<string, unknown>[] {
  return context.mocks.axiom.sdkIngest.mock.calls.flatMap((call) => {
    const dataset = call[0];
    const events = call[1];
    if (dataset !== "vm0-sandbox-op-log-dev" || !Array.isArray(events)) {
      return [];
    }
    return events.filter((event): event is Record<string, unknown> => {
      if (!isRecord(event)) {
        return false;
      }
      return event.run_id === runId;
    });
  });
}

async function runForFixturePrompt(
  fixture: TelegramPostFixture,
  prompt: string,
): Promise<TelegramRunSnapshot | null> {
  return (await telegramPostRunState(fixture, prompt)).run;
}

async function latestZeroRunForFixture(
  fixture: TelegramPostFixture,
): Promise<TelegramZeroRunSnapshot | null> {
  return (await telegramPostRunState(fixture)).zeroRun;
}

function mentionEntity(username: string) {
  return { type: "mention", offset: 0, length: username.length + 1 };
}

async function linkedTelegramUserLinkId(
  fixture: TelegramPostFixture,
): Promise<string> {
  const response = await postTelegramStateAction({
    action: "get-telegram-link-id",
    installation_id: fixture.telegramBotId,
    user_id: fixture.userId,
  });
  if (typeof response.link_id !== "string") {
    throw new Error("Expected seeded Telegram user link");
  }
  return response.link_id;
}

async function officialTelegramUserLinkId(
  fixture: TelegramPostFixture,
): Promise<string> {
  const response = await postTelegramStateAction({
    action: "get-telegram-link-id",
    kind: "official",
    org_id: fixture.orgId,
    user_id: fixture.userId,
  });
  if (typeof response.link_id !== "string") {
    throw new Error("Expected seeded official Telegram user link");
  }
  return response.link_id;
}

async function seedAgentSession(fixture: TelegramPostFixture): Promise<string> {
  const response = await postTelegramStateAction({
    action: "seed-agent-session",
    org_id: fixture.orgId,
    user_id: fixture.userId,
    compose_id: fixture.composeId,
  });
  if (typeof response.agent_session_id !== "string") {
    throw new Error("Failed to seed Telegram agent session");
  }
  return response.agent_session_id;
}

async function seedTelegramThreadSession(args: {
  readonly fixture: TelegramPostFixture;
  readonly telegramUserLinkId?: string;
  readonly telegramOfficialUserLinkId?: string;
  readonly chatId: string;
  readonly rootMessageId: string;
  readonly agentSessionId: string;
}): Promise<void> {
  await postTelegramStateAction({
    action: "seed-thread-session",
    org_id: args.fixture.orgId,
    user_id: args.fixture.userId,
    compose_id: args.fixture.composeId,
    user_link_id: args.telegramUserLinkId,
    official_user_link_id: args.telegramOfficialUserLinkId,
    chat_id: args.chatId,
    root_message_id: args.rootMessageId,
    agent_session_id: args.agentSessionId,
  });
}

async function hasTelegramThreadSession(args: {
  readonly telegramUserLinkId: string;
  readonly chatId: string;
  readonly rootMessageId: string;
}): Promise<boolean> {
  const response = await postTelegramStateAction({
    action: "has-thread-session",
    user_link_id: args.telegramUserLinkId,
    chat_id: args.chatId,
    root_message_id: args.rootMessageId,
  });
  return response.exists === true;
}

async function seedRunningRun(fixture: TelegramPostFixture): Promise<void> {
  await postTelegramStateAction({
    action: "seed-running-run",
    org_id: fixture.orgId,
    user_id: fixture.userId,
    version_id: fixture.versionId,
    compose_id: fixture.composeId,
  });
}

async function seedCompletedRun(args: {
  readonly fixture: TelegramPostFixture;
  readonly modelProvider?: string | null;
  readonly selectedModel: string;
}): Promise<string> {
  const response = await postTelegramStateAction({
    action: "seed-completed-run",
    org_id: args.fixture.orgId,
    user_id: args.fixture.userId,
    version_id: args.fixture.versionId,
    compose_id: args.fixture.composeId,
    model_provider: args.modelProvider,
    selected_model: args.selectedModel,
  });
  if (typeof response.agent_session_id !== "string") {
    throw new Error("Failed to seed previous Telegram run");
  }
  return response.agent_session_id;
}

async function seedModelPolicies(args: {
  readonly fixture: TelegramPostFixture;
  readonly selectedModel?: string | null;
}): Promise<void> {
  await postTelegramStateAction({
    action: "seed-model-policies",
    org_id: args.fixture.orgId,
    user_id: args.fixture.userId,
    compose_id: args.fixture.composeId,
    selected_model: args.selectedModel,
  });
}

async function seedOrgCredits(
  fixture: TelegramPostFixture,
  credits: number,
): Promise<void> {
  await postTelegramStateAction({
    action: "seed-org-credits",
    org_id: fixture.orgId,
    credits,
  });
}

async function selectedModelFor(
  fixture: TelegramPostFixture,
): Promise<string | null> {
  const response = await postTelegramStateAction({
    action: "get-selected-model",
    org_id: fixture.orgId,
    user_id: fixture.userId,
  });
  return typeof response.selected_model === "string"
    ? response.selected_model
    : null;
}

async function seedPendingUserLink(
  fixture: TelegramPostFixture,
): Promise<void> {
  await postTelegramStateAction({
    action: "seed-pending-user-link",
    installation_id: fixture.telegramBotId,
    user_id: fixture.userId,
  });
}

describe("POST /api/telegram/setup-status", () => {
  it("requires an authenticated organization session", async () => {
    const response = await accept(
      telegramClient().setupStatus({
        headers: {},
        body: { botToken: TEST_BOT_TOKEN },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 400 when botToken is missing", async () => {
    mocks.clerk.session("user_missing_token", "org_missing_token");

    const response = await createApp({ signal: context.signal }).request(
      "/api/telegram/setup-status",
      {
        method: "POST",
        headers: {
          authorization: "Bearer clerk-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "botToken is required", code: "BAD_REQUEST" },
    });
  });

  it("returns 400 when bot token is invalid", async () => {
    mocks.clerk.session("user_invalid_token", "org_invalid_token");
    context.mocks.telegram.getMe.mockRejectedValue(new Error("Unauthorized"));

    const response = await accept(
      telegramClient().setupStatus({
        headers: { authorization: "Bearer clerk-session" },
        body: { botToken: TEST_BOT_TOKEN },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.message).toContain("Invalid bot token");
  });

  it("returns setup status for a valid bot token", async () => {
    const botId = newTelegramBotId();
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    mocks.clerk.session(userId, orgId);
    mockTelegramGetMe({
      botId,
      username: "setup_bot",
      privacyDisabled: true,
    });
    server.use(telegramOauthHead("2048", "https://example.test"));

    const response = await accept(
      telegramClient().setupStatus({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          botToken: TEST_BOT_TOKEN,
          origin: "https://example.test/settings/telegram",
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      id: botId,
      username: "setup_bot",
      domainConfigured: true,
      privacyDisabled: true,
    });
  });

  it("rejects an already installed bot", async () => {
    const fixture = await trackFixture(
      seedTelegramPostFixture({ linkTelegramUser: false }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockTelegramGetMe({ botId: fixture.telegramBotId });

    const response = await accept(
      telegramClient().setupStatus({
        headers: { authorization: "Bearer clerk-session" },
        body: { botToken: TEST_BOT_TOKEN },
      }),
      [409],
    );

    expect(response.body.error.message).toContain("already installed");
  });
});

describe("POST /api/telegram/register", () => {
  it("requires an authenticated organization session", async () => {
    const response = await accept(
      telegramClient().register({
        headers: {},
        body: { botToken: TEST_BOT_TOKEN },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 400 when botToken is missing", async () => {
    mocks.clerk.session("user_register_missing_token", "org_register_missing");

    const response = await postRegisterRaw({});

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "botToken is required", code: "BAD_REQUEST" },
    });
  });

  it("returns 400 when bot token is invalid", async () => {
    mocks.clerk.session("user_register_invalid_token", "org_register_invalid");
    context.mocks.telegram.getMe.mockRejectedValue(new Error("Unauthorized"));

    const response = await accept(
      telegramClient().register({
        headers: { authorization: "Bearer clerk-session" },
        body: { botToken: TEST_BOT_TOKEN },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.message).toContain("Invalid bot token");
  });

  it("registers a custom Telegram bot and configures its webhook", async () => {
    const telegramBotId = newTelegramBotId();
    const fixture = await trackFixture(
      seedTelegramPostFixture({ telegramBotId, installBot: false }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockEnv("VM0_API_URL", "https://api.example.test");
    mockEnv("VM0_WEB_URL", "https://www.example.test");
    mockEnv("APP_URL", "https://app.example.test");
    mockTelegramGetMe({ botId: telegramBotId, username: "registered_bot" });
    context.mocks.telegram.setWebhook.mockResolvedValue(undefined);
    context.mocks.telegram.setMyCommands.mockResolvedValue(undefined);
    server.use(telegramOauthHead("1001", "https://app.example.test"));

    const response = await accept(
      telegramClient().register({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          botToken: TEST_BOT_TOKEN,
          defaultAgentId: fixture.composeId,
        },
      }),
      [201],
    );

    expect(response.body).toMatchObject({
      id: telegramBotId,
      username: "registered_bot",
      tokenStatus: "valid",
      domainConfigured: true,
      agent: { id: fixture.composeId },
      isOwner: true,
      isConnected: false,
    });
    expect(context.mocks.telegram.setWebhook).toHaveBeenCalledWith(
      TEST_BOT_TOKEN,
      `https://www.example.test/api/telegram/webhook/${telegramBotId}`,
      expect.stringMatching(/^[0-9a-f]{64}$/u),
    );
    expect(context.mocks.telegram.setMyCommands).toHaveBeenCalledWith(
      TEST_BOT_TOKEN,
      expect.arrayContaining([expect.objectContaining({ command: "connect" })]),
    );

    const state = await readTelegramState(telegramBotId);
    const installation = stateRecord(state.installation);
    expect(installation?.defaultComposeId).toBe(fixture.composeId);
    expect(installation?.botUsername).toBe("registered_bot");
  });

  it("uses the active org default agent when defaultAgentId is omitted", async () => {
    const telegramBotId = newTelegramBotId();
    const fixture = await trackFixture(
      seedTelegramPostFixture({ telegramBotId, installBot: false }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockTelegramGetMe({
      botId: telegramBotId,
      username: `default_bot_${telegramBotId}`,
    });
    context.mocks.telegram.setWebhook.mockResolvedValue(undefined);
    context.mocks.telegram.setMyCommands.mockResolvedValue(undefined);

    const response = await accept(
      telegramClient().register({
        headers: { authorization: "Bearer clerk-session" },
        body: { botToken: TEST_BOT_TOKEN },
      }),
      [201],
    );

    expect(response.body.id).toBe(telegramBotId);
    expect(response.body.agent).toStrictEqual({
      id: fixture.composeId,
      name: expect.any(String),
    });
  });

  it("rejects an empty defaultAgentId before verifying the token", async () => {
    mocks.clerk.session("user_register_empty_agent", "org_register_empty");

    const response = await accept(
      telegramClient().register({
        headers: { authorization: "Bearer clerk-session" },
        body: { botToken: TEST_BOT_TOKEN, defaultAgentId: "" },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.message).toContain("defaultAgentId");
    expect(context.mocks.telegram.getMe).not.toHaveBeenCalled();
  });

  it("returns 409 when bot is already registered", async () => {
    const fixture = await trackFixture(seedTelegramPostFixture({}));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockTelegramGetMe({ botId: fixture.telegramBotId });

    const response = await accept(
      telegramClient().register({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          botToken: TEST_BOT_TOKEN,
          defaultAgentId: fixture.composeId,
        },
      }),
      [409],
    );

    expect(response.body.error.code).toBe("CONFLICT");
    expect(response.body.error.message).toContain("/connect");
    expect(context.mocks.telegram.setWebhook).not.toHaveBeenCalled();
  });

  it("reinstalls an existing bot when reinstallBotId matches the token bot id", async () => {
    const fixture = await trackFixture(seedTelegramPostFixture({}));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockTelegramGetMe({
      botId: fixture.telegramBotId,
      username: `reinstall_bot_${fixture.telegramBotId}`,
    });
    context.mocks.telegram.setWebhook.mockResolvedValue(undefined);
    context.mocks.telegram.setMyCommands.mockResolvedValue(undefined);

    const response = await accept(
      telegramClient().register({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          botToken: NEW_BOT_TOKEN,
          reinstallBotId: fixture.telegramBotId,
        },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      id: fixture.telegramBotId,
      tokenStatus: "valid",
      agent: { id: fixture.composeId },
    });
    expect(context.mocks.telegram.setWebhook).toHaveBeenCalledWith(
      NEW_BOT_TOKEN,
      expect.stringContaining(`/api/telegram/webhook/${fixture.telegramBotId}`),
      expect.stringMatching(/^[0-9a-f]{64}$/u),
    );
    expect(context.mocks.telegram.setMyCommands).toHaveBeenCalledWith(
      NEW_BOT_TOKEN,
      expect.arrayContaining([expect.objectContaining({ command: "connect" })]),
    );

    const state = await readTelegramState(fixture.telegramBotId);
    const installation = stateRecord(state.installation);
    expect(installation?.telegramBotId).toBe(fixture.telegramBotId);
    expect(installation?.botUsername).toBe(
      `reinstall_bot_${fixture.telegramBotId}`,
    );
  });

  it("rejects reinstall when the token belongs to a different bot", async () => {
    const fixture = await trackFixture(seedTelegramPostFixture({}));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockTelegramGetMe({ botId: newTelegramBotId() });

    const response = await accept(
      telegramClient().register({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          botToken: NEW_BOT_TOKEN,
          reinstallBotId: fixture.telegramBotId,
        },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.message).toContain("different Telegram bot");
    expect(context.mocks.telegram.setWebhook).not.toHaveBeenCalled();
  });

  it("returns 400 when no default agent is available", async () => {
    const telegramBotId = newTelegramBotId();
    const fixture = await trackFixture(
      seedTelegramPostFixture({
        telegramBotId,
        installBot: false,
        seedDefaultAgent: false,
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockTelegramGetMe({ botId: telegramBotId });

    const response = await accept(
      telegramClient().register({
        headers: { authorization: "Bearer clerk-session" },
        body: { botToken: TEST_BOT_TOKEN },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.message).toContain("No default agent specified");
  });

  it("returns 404 when defaultAgentId references a nonexistent agent", async () => {
    mocks.clerk.session("user_register_missing_agent", "org_register_missing");
    mockTelegramGetMe({ botId: newTelegramBotId() });

    const response = await accept(
      telegramClient().register({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          botToken: TEST_BOT_TOKEN,
          defaultAgentId: "00000000-0000-0000-0000-000000000000",
        },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(response.body.error.message).toContain("Agent not found");
  });

  it("returns 403 when defaultAgentId belongs to another org", async () => {
    const otherFixture = await trackFixture(
      seedTelegramPostFixture({
        orgId: `org_other_${randomUUID().slice(0, 8)}`,
        userId: `user_other_${randomUUID().slice(0, 8)}`,
        installBot: false,
      }),
    );
    mocks.clerk.session("user_register_cross_org", "org_register_cross");
    mockTelegramGetMe({ botId: newTelegramBotId() });

    const response = await accept(
      telegramClient().register({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          botToken: TEST_BOT_TOKEN,
          defaultAgentId: otherFixture.composeId,
        },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("rolls back a new installation when webhook registration fails", async () => {
    const telegramBotId = newTelegramBotId();
    const fixture = await trackFixture(
      seedTelegramPostFixture({ telegramBotId, installBot: false }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockTelegramGetMe({ botId: telegramBotId });
    context.mocks.telegram.setWebhook.mockRejectedValue(
      new Error("telegram unavailable"),
    );

    const response = await accept(
      telegramClient().register({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          botToken: TEST_BOT_TOKEN,
          defaultAgentId: fixture.composeId,
        },
      }),
      [502],
    );

    expect(response.body.error.code).toBe("BAD_GATEWAY");
    const state = await readTelegramState(telegramBotId);
    expect(state.installation).toBeNull();
  });
});

describe("POST /api/telegram/webhook/:telegramBotId", () => {
  it("validates bot ownership, webhook secret, and JSON payload", async () => {
    const fixture = await trackFixture(seedTelegramPostFixture({}));

    const missing = await postWebhook({
      telegramBotId: newTelegramBotId(),
      secret: fixture.webhookSecret,
      body: {},
    });
    expect(missing.status).toBe(404);
    await expect(missing.text()).resolves.toBe("Not Found");

    const unauthorized = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: "wrong-secret",
      body: {},
    });
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.text()).resolves.toBe("Unauthorized");

    const badJson = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: "{not-json",
    });
    expect(badJson.status).toBe(400);
    await expect(badJson.text()).resolves.toBe("Bad Request");
  });

  it("creates a Zero run for a linked custom-bot private message", async () => {
    const fixture = await trackFixture(
      seedTelegramPostFixture({ linkTelegramUser: true }),
    );
    const telegramMocks = telegramApiMocks();

    const response = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 1,
        message: {
          message_id: 42,
          chat: { id: 77_001, type: "private" },
          from: {
            id: Number(fixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
            language_code: "en",
          },
          text: "hello from telegram",
        },
      },
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("OK");
    await flushWaitUntilForTest();

    const run = await latestRunForFixture(fixture);
    expect(run).toMatchObject({ status: "pending", error: null });
    expect(run?.prompt).toBe("hello from telegram");
    expect(run?.appendSystemPrompt).toContain("Telegram username: @alice");
    expect(run?.appendSystemPrompt).toContain("Bot ID:");
    expect(telegramMocks.chatActions).toHaveLength(1);
    expect(telegramMocks.sentMessages).toHaveLength(0);

    const runState = await telegramPostRunState(fixture);
    expect(runState.zeroRun?.triggerSource).toBe("telegram");
    expect(runState.callbacks[0]).toMatchObject({
      url: null,
      internalKind: "telegram",
    });
    expect(runState.jobExists).toBeTruthy();
    const timingEvents = sandboxOperationEventsForRun(run!.id).filter(
      (event) => {
        return (
          typeof event.op_type === "string" &&
          event.op_type.startsWith("api_dispatch_")
        );
      },
    );
    expect(timingEvents).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op_type: "api_dispatch_pre_create_agent_run",
          span_kind: "top_level",
          trigger_source: "telegram",
          zero_run_origin: "zero_run",
        }),
        expect.objectContaining({
          op_type: "api_dispatch_pre_create_zero_entrypoint_gap",
          span_kind: "nested",
          trigger_source: "telegram",
        }),
        expect.objectContaining({
          op_type: "api_dispatch_pre_create_zero_load_agent",
          span_kind: "nested",
          trigger_source: "telegram",
        }),
        expect.objectContaining({
          op_type: "api_dispatch_pre_create_zero_load_connector_scopes",
          span_kind: "nested",
          trigger_source: "telegram",
        }),
        expect.objectContaining({
          op_type: "api_dispatch_pre_create_zero_build_create_run_args",
          span_kind: "nested",
          trigger_source: "telegram",
        }),
      ]),
    );
    const timingActionTypes = timingEvents.map((event) => {
      return event.op_type;
    });
    expect(timingActionTypes).not.toContain(
      "api_dispatch_pre_create_zero_parse_body",
    );
    expect(timingActionTypes).not.toContain(
      "api_dispatch_pre_create_zero_prepare_args",
    );
  });

  it("keeps Telegram callbacks typed when VM0_API_BACKEND_URL is set", async () => {
    mockEnv("VM0_API_URL", "https://www.vm0.ai");
    mockEnv("VM0_API_BACKEND_URL", "https://api.vm0.ai");
    const fixture = await trackFixture(
      seedTelegramPostFixture({ linkTelegramUser: true }),
    );
    telegramApiMocks();

    const response = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 1,
        message: {
          message_id: 42,
          chat: { id: 77_001, type: "private" },
          from: {
            id: Number(fixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
            language_code: "en",
          },
          text: "hello from telegram",
        },
      },
    });
    expect(response.status).toBe(200);
    await flushWaitUntilForTest();

    const runState = await telegramPostRunState(fixture);
    expect(runState.run).toBeDefined();
    expect(runState.callbacks[0]).toMatchObject({
      url: null,
      internalKind: "telegram",
    });
  });

  it("formats generic failed callback errors for Telegram replies", async () => {
    const fixture = await trackFixture(
      seedTelegramPostFixture({ linkTelegramUser: true }),
    );
    const telegramMocks = telegramApiMocks();

    const webhookResponse = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 2,
        message: {
          message_id: 43,
          chat: { id: 77_002, type: "private" },
          from: {
            id: Number(fixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
          },
          text: "trigger failed callback",
        },
      },
    });
    expect(webhookResponse.status).toBe(200);
    await flushWaitUntilForTest();

    const run = await latestRunForFixture(fixture);
    expect(run?.id).toBeDefined();
    const payload = {
      installationId: fixture.telegramBotId,
      chatId: "77002",
      messageId: "43",
      rootMessageId: null,
      userLinkId: await linkedTelegramUserLinkId(fixture),
      agentId: fixture.composeId,
      existingSessionId: null,
      isDM: true,
    };
    const callback = await postTelegramStateAction({
      action: "update-run-callback",
      run_id: run!.id,
      url: null,
      internal_kind: "telegram",
      payload,
      secret: CALLBACK_SECRET,
    });
    if (typeof callback.callback_id !== "string") {
      throw new Error("Expected Telegram callback row");
    }

    await expect(
      postTelegramCallback({
        callbackId: callback.callback_id,
        runId: run!.id,
        status: "failed",
        error: "thread/resume failed: rollout is empty",
        payload,
      }),
    ).resolves.toStrictEqual({ success: true });
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages.at(-1)?.text).toContain(
      "Oops, something went wrong. Please try again later.",
    );
  });

  it("stores non-addressed group messages without creating a run", async () => {
    const fixture = await trackFixture(seedTelegramPostFixture({}));

    const response = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 2,
        message: {
          message_id: 99,
          chat: { id: -10_099_001, type: "group" },
          from: { id: 44_001, username: "carol", first_name: "Carol" },
          text: "ambient group chatter",
        },
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();

    await expect(latestRunForFixture(fixture)).resolves.toBeNull();
    const messages = stateRecords(
      (await readTelegramState(fixture.telegramBotId)).messages,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe("ambient group chatter");
  });

  it("stores custom-bot group replies to another bot without sending a prompt", async () => {
    const fixture = await trackFixture(seedTelegramPostFixture({}));
    const telegramMocks = telegramApiMocks();

    const response = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 22,
        message: {
          message_id: 202,
          chat: { id: -10_099_022, type: "group" },
          from: { id: 44_022, username: "carol", first_name: "Carol" },
          text: "following up",
          reply_to_message: {
            message_id: 55,
            chat: { id: -10_099_022, type: "group" },
            from: { id: 123, is_bot: true, username: "other_bot" },
            text: "message from another bot",
          },
        },
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages).toHaveLength(0);

    const messages = stateRecords(
      (await readTelegramState(fixture.telegramBotId)).messages,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe("following up");
  });

  it("creates a Zero run for a linked custom-bot group mention", async () => {
    const fixture = await trackFixture(
      seedTelegramPostFixture({ linkTelegramUser: true }),
    );
    const botUsername = `bot_${fixture.telegramBotId}`;
    telegramApiMocks();

    const response = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 3,
        message: {
          message_id: 101,
          chat: { id: -10_099_002, type: "group" },
          from: {
            id: Number(fixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
          },
          text: `@${botUsername} summarize this thread`,
          entities: [mentionEntity(botUsername)],
        },
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();

    const run = await latestRunForFixture(fixture);
    expect(run?.prompt).toBe("summarize this thread");
    expect(run?.appendSystemPrompt).toContain("Chat type: group");
  });

  it("creates a Zero run for a linked official-bot private message", async () => {
    configureOfficialBotEnv();
    const fixture = await trackFixture(
      seedTelegramPostFixture({ installBot: false, seedOfficialLink: true }),
    );
    telegramApiMocks(OFFICIAL_BOT_TOKEN);

    const response = await postWebhook({
      telegramBotId: "official",
      secret: OFFICIAL_WEBHOOK_SECRET,
      body: {
        update_id: 4,
        message: {
          message_id: 51,
          chat: { id: 88_002, type: "private" },
          from: {
            id: 99_002,
            username: "bob",
            first_name: "Bob",
            language_code: "en",
          },
          text: "run through official bot",
        },
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();

    const run = await latestRunForFixture(fixture);
    expect(run?.prompt).toBe("run through official bot");
    expect(run?.appendSystemPrompt).toContain(
      "Bot username: @official_zero_bot",
    );
    await expect(latestZeroRunForFixture(fixture)).resolves.toMatchObject({
      triggerSource: "telegram",
    });
  });

  it("creates a Zero run for a linked official-bot group mention", async () => {
    configureOfficialBotEnv();
    const fixture = await trackFixture(
      seedTelegramPostFixture({ installBot: false, seedOfficialLink: true }),
    );
    telegramApiMocks(OFFICIAL_BOT_TOKEN);

    const response = await postWebhook({
      telegramBotId: "official",
      secret: OFFICIAL_WEBHOOK_SECRET,
      body: {
        update_id: 5,
        message: {
          message_id: 52,
          chat: { id: -10_099_003, type: "group" },
          from: {
            id: 99_002,
            username: "bob",
            first_name: "Bob",
          },
          text: `@${OFFICIAL_BOT_USERNAME} help from a group`,
          entities: [mentionEntity(OFFICIAL_BOT_USERNAME)],
        },
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();

    const run = await latestRunForFixture(fixture);
    expect(run?.prompt).toBe("help from a group");
    expect(run?.appendSystemPrompt).toContain(
      "Bot username: @official_zero_bot",
    );
  });

  it("routes custom-bot commands by username target", async () => {
    const fixture = await trackFixture(seedTelegramPostFixture({}));
    const botUsername = `bot_${fixture.telegramBotId}`;
    const telegramMocks = telegramApiMocks();

    const ignored = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 6,
        message: {
          message_id: 61,
          chat: { id: -10_099_004, type: "group" },
          from: { id: 44_002, username: "carol", first_name: "Carol" },
          text: "/help@other_bot",
        },
      },
    });

    expect(ignored.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages).toHaveLength(0);

    const routed = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 7,
        message: {
          message_id: 62,
          chat: { id: -10_099_004, type: "group" },
          from: { id: 44_002, username: "carol", first_name: "Carol" },
          text: `/connect@${botUsername}`,
        },
      },
    });

    expect(routed.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages).toHaveLength(1);
    expect(telegramMocks.sentMessages[0]?.text).toContain(
      "please connect your account first",
    );
    expect(
      telegramMocks.sentMessages[0]?.reply_markup?.inline_keyboard[0]?.[0]?.url,
    ).toBe(`https://t.me/${botUsername}?start=connect`);
  });

  it("handles custom-bot connect and help command copy", async () => {
    const fixture = await trackFixture(
      seedTelegramPostFixture({ linkTelegramUser: true }),
    );
    const telegramMocks = telegramApiMocks();

    const connected = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 61,
        message: {
          message_id: 611,
          chat: { id: Number(fixture.telegramUserId), type: "private" },
          from: {
            id: Number(fixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
          },
          text: "/connect",
        },
      },
    });
    expect(connected.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages[0]?.text).toContain("already connected");
    expect(telegramMocks.sentMessages[0]?.text).toContain("Telegram Agent");

    const unlinked = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 62,
        message: {
          message_id: 612,
          chat: { id: 91_612, type: "private" },
          from: { id: 91_612, username: "unlinked", first_name: "Unlinked" },
          text: "/connect",
        },
      },
    });
    expect(unlinked.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages[1]?.text).toContain(
      "To use Telegram Agent in Telegram",
    );
    const buttonUrl =
      telegramMocks.sentMessages[1]?.reply_markup?.inline_keyboard[0]?.[0]
        ?.url ?? "";
    expect(buttonUrl).toContain("http://localhost:3002/telegram/connect?bot=");
    expect(buttonUrl).toContain("tgUser=91612");

    const help = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 63,
        message: {
          message_id: 613,
          chat: { id: Number(fixture.telegramUserId), type: "private" },
          from: {
            id: Number(fixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
          },
          text: "/help",
        },
      },
    });
    expect(help.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages[2]?.text).toContain(
      "Telegram Agent Telegram Bot Help",
    );
    expect(telegramMocks.sentMessages[2]?.text).toContain("/new_session");
    expect(telegramMocks.sentMessages[2]?.text).not.toContain("admin");
  });

  it("handles custom-bot disconnect command", async () => {
    const fixture = await trackFixture(
      seedTelegramPostFixture({ linkTelegramUser: true }),
    );
    const telegramMocks = telegramApiMocks();

    const response = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 8,
        message: {
          message_id: 71,
          chat: { id: 77_003, type: "private" },
          from: {
            id: Number(fixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
          },
          text: "/disconnect",
        },
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();

    const links = stateRecords(
      (await readTelegramState(fixture.telegramBotId)).links,
    );
    expect(links).toHaveLength(0);
    expect(telegramMocks.sentMessages[0]?.text).toContain(
      "You have been disconnected",
    );
  });

  it("completes a pending custom-bot link on the first private message", async () => {
    const fixture = await trackFixture(seedTelegramPostFixture({}));
    await seedPendingUserLink(fixture);
    telegramApiMocks();

    const response = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 81,
        message: {
          message_id: 811,
          chat: { id: 78_901, type: "private" },
          from: { id: 78_901, username: "admin_user", first_name: "Admin" },
          text: "hello bot",
        },
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();

    const links = stateRecords(
      (await readTelegramState(fixture.telegramBotId)).links,
    );
    expect(links).toStrictEqual([
      expect.objectContaining({
        telegramUserId: "78901",
        telegramUsername: "admin_user",
      }),
    ]);
  });

  it("clears a custom-bot private thread with /new_session and ignores the command in groups", async () => {
    const fixture = await trackFixture(
      seedTelegramPostFixture({ linkTelegramUser: true }),
    );
    const userLinkId = await linkedTelegramUserLinkId(fixture);
    const sessionId = await seedAgentSession(fixture);
    await seedTelegramThreadSession({
      fixture,
      telegramUserLinkId: userLinkId,
      chatId: fixture.telegramUserId!,
      rootMessageId: "dm",
      agentSessionId: sessionId,
    });
    const telegramMocks = telegramApiMocks();

    const group = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 91,
        message: {
          message_id: 911,
          chat: { id: -10_099_091, type: "group" },
          from: {
            id: Number(fixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
          },
          text: "/new_session",
        },
      },
    });
    expect(group.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages).toHaveLength(0);
    await expect(
      hasTelegramThreadSession({
        telegramUserLinkId: userLinkId,
        chatId: fixture.telegramUserId!,
        rootMessageId: "dm",
      }),
    ).resolves.toBeTruthy();

    const dm = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 92,
        message: {
          message_id: 912,
          chat: { id: Number(fixture.telegramUserId), type: "private" },
          from: {
            id: Number(fixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
          },
          text: "/new_session",
        },
      },
    });
    expect(dm.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages[0]?.text).toContain(
      "New session started",
    );
    await expect(
      hasTelegramThreadSession({
        telegramUserLinkId: userLinkId,
        chatId: fixture.telegramUserId!,
        rootMessageId: "dm",
      }),
    ).resolves.toBeFalsy();
  });

  it("lists, updates, and rejects model command arguments", async () => {
    const fixture = await trackFixture(
      seedTelegramPostFixture({ linkTelegramUser: true }),
    );
    await seedModelPolicies({
      fixture,
      selectedModel: "deepseek-v4-pro",
    });
    const telegramMocks = telegramApiMocks();

    const list = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 101,
        message: {
          message_id: 1011,
          chat: { id: Number(fixture.telegramUserId), type: "private" },
          from: {
            id: Number(fixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
          },
          text: "/model",
        },
      },
    });
    expect(list.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages[0]?.text).toContain("Available models");
    expect(telegramMocks.sentMessages[0]?.text).toContain(
      "/model claude-sonnet-4-6",
    );
    expect(telegramMocks.sentMessages[0]?.text).toContain(
      "/model deepseek-v4-pro",
    );
    expect(telegramMocks.sentMessages[0]?.text).not.toContain("/model default");

    const switchModel = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 102,
        message: {
          message_id: 1012,
          chat: { id: Number(fixture.telegramUserId), type: "private" },
          from: {
            id: Number(fixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
          },
          text: "/model Claude Sonnet 4.6",
        },
      },
    });
    expect(switchModel.status).toBe(200);
    await flushWaitUntilForTest();
    await expect(selectedModelFor(fixture)).resolves.toBe("claude-sonnet-4-6");

    const defaultModel = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 103,
        message: {
          message_id: 1013,
          chat: { id: Number(fixture.telegramUserId), type: "private" },
          from: {
            id: Number(fixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
          },
          text: "/model default",
        },
      },
    });
    expect(defaultModel.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages[2]?.text).toContain(
      "Unknown model &quot;default&quot;.",
    );
    await expect(selectedModelFor(fixture)).resolves.toBe("claude-sonnet-4-6");
  });

  it("sends typing for accepted custom-bot runs and a queued message at the concurrency limit", async () => {
    const acceptedFixture = await trackFixture(
      seedTelegramPostFixture({ linkTelegramUser: true }),
    );
    const acceptedTelegramMocks = telegramApiMocks();

    const accepted = await postWebhook({
      telegramBotId: acceptedFixture.telegramBotId,
      secret: acceptedFixture.webhookSecret,
      body: {
        update_id: 111,
        message: {
          message_id: 1111,
          chat: { id: Number(acceptedFixture.telegramUserId), type: "private" },
          from: {
            id: Number(acceptedFixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
          },
          text: "accepted telegram run",
        },
      },
    });
    expect(accepted.status).toBe(200);
    await flushWaitUntilForTest();
    expect(acceptedTelegramMocks.chatActions).toHaveLength(1);
    expect(acceptedTelegramMocks.sentMessages).toHaveLength(0);

    const queuedFixture = await trackFixture(
      seedTelegramPostFixture({ linkTelegramUser: true }),
    );
    await seedRunningRun(queuedFixture);
    const queuedTelegramMocks = telegramApiMocks();

    const queued = await postWebhook({
      telegramBotId: queuedFixture.telegramBotId,
      secret: queuedFixture.webhookSecret,
      body: {
        update_id: 112,
        message: {
          message_id: 1112,
          chat: { id: Number(queuedFixture.telegramUserId), type: "private" },
          from: {
            id: Number(queuedFixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
          },
          text: "queued telegram run",
        },
      },
    });
    expect(queued.status).toBe(200);
    await flushWaitUntilForTest();
    expect(queuedTelegramMocks.chatActions).toHaveLength(1);
    expect(queuedTelegramMocks.sentMessages[0]?.text).toContain("Run queued");
    expect(queuedTelegramMocks.sentMessages[0]?.text).toContain(
      "concurrency limit reached",
    );
  });

  it("does not prompt unlinked official group replies to another bot but prompts replies to Zero", async () => {
    configureOfficialBotEnv();
    const telegramMocks = telegramApiMocks(OFFICIAL_BOT_TOKEN);

    const otherBotReply = await postWebhook({
      telegramBotId: OFFICIAL_TELEGRAM_BOT_ID,
      secret: OFFICIAL_WEBHOOK_SECRET,
      body: {
        update_id: 121,
        message: {
          message_id: 1211,
          chat: { id: -10_099_121, type: "group" },
          from: { id: 93_121, username: "unlinked", first_name: "Unlinked" },
          text: "following up",
          reply_to_message: {
            message_id: 44,
            chat: { id: -10_099_121, type: "group" },
            from: { id: 123, is_bot: true, username: "other_bot" },
            text: "message from another bot",
          },
        },
      },
    });
    expect(otherBotReply.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages).toHaveLength(0);

    const zeroReply = await postWebhook({
      telegramBotId: OFFICIAL_TELEGRAM_BOT_ID,
      secret: OFFICIAL_WEBHOOK_SECRET,
      body: {
        update_id: 122,
        message: {
          message_id: 1212,
          chat: { id: -10_099_121, type: "group" },
          from: { id: 93_121, username: "unlinked", first_name: "Unlinked" },
          text: "following up",
          reply_to_message: {
            message_id: 45,
            chat: { id: -10_099_121, type: "group" },
            from: {
              id: 987_654_321,
              is_bot: true,
              username: OFFICIAL_BOT_USERNAME,
            },
            text: "message from zero",
          },
        },
      },
    });
    expect(zeroReply.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages).toHaveLength(1);
    expect(telegramMocks.sentMessages[0]?.text).toContain(
      "connect your account",
    );
    expect(telegramMocks.sentMessages[0]?.reply_parameters).toStrictEqual({
      message_id: 1212,
    });
  });

  it("starts a new official DM session when the selected model changed", async () => {
    configureOfficialBotEnv();
    const fixture = await trackFixture(
      seedTelegramPostFixture({
        installBot: false,
        seedOfficialLink: true,
      }),
    );
    await seedModelPolicies({
      fixture,
      selectedModel: "claude-opus-4-7",
    });
    await seedOrgCredits(fixture, 100_000);
    const previousSessionId = await seedCompletedRun({
      fixture,
      selectedModel: "claude-sonnet-4-6",
    });
    await seedTelegramThreadSession({
      fixture,
      telegramOfficialUserLinkId: await officialTelegramUserLinkId(fixture),
      chatId: "99002",
      rootMessageId: "dm",
      agentSessionId: previousSessionId,
    });
    const telegramMocks = telegramApiMocks(OFFICIAL_BOT_TOKEN);

    const response = await postWebhook({
      telegramBotId: OFFICIAL_TELEGRAM_BOT_ID,
      secret: OFFICIAL_WEBHOOK_SECRET,
      body: {
        update_id: 131,
        message: {
          message_id: 1311,
          chat: { id: 99_002, type: "private" },
          from: { id: 99_002, username: "bob", first_name: "Bob" },
          text: "model changed telegram session",
        },
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages).toStrictEqual([]);

    const run = await runForFixturePrompt(
      fixture,
      "model changed telegram session",
    );
    expect(run?.prompt).toBe("model changed telegram session");
    expect(run?.continuedFromSessionId).toBeNull();
    expect(run?.sessionId).not.toBe(previousSessionId);
    await expect(latestZeroRunForFixture(fixture)).resolves.toStrictEqual(
      expect.objectContaining({
        selectedModel: "claude-opus-4-7",
      }),
    );
  });

  it("starts a new custom DM session when the selected model provider changed", async () => {
    const fixture = await trackFixture(
      seedTelegramPostFixture({ linkTelegramUser: true }),
    );
    await seedModelPolicies({
      fixture,
      selectedModel: "claude-sonnet-4-6",
    });
    await seedOrgCredits(fixture, 100_000);
    const previousSessionId = await seedCompletedRun({
      fixture,
      modelProvider: "openrouter-api-key",
      selectedModel: "claude-sonnet-4-6",
    });
    await seedTelegramThreadSession({
      fixture,
      telegramUserLinkId: await linkedTelegramUserLinkId(fixture),
      chatId: fixture.telegramUserId!,
      rootMessageId: "dm",
      agentSessionId: previousSessionId,
    });
    const telegramMocks = telegramApiMocks();

    const response = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 132,
        message: {
          message_id: 1321,
          chat: { id: Number(fixture.telegramUserId), type: "private" },
          from: {
            id: Number(fixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
          },
          text: "provider changed telegram session",
        },
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages).toStrictEqual([]);

    const run = await runForFixturePrompt(
      fixture,
      "provider changed telegram session",
    );
    expect(run?.prompt).toBe("provider changed telegram session");
    expect(run?.continuedFromSessionId).toBeNull();
    expect(run?.sessionId).not.toBe(previousSessionId);
    await expect(latestZeroRunForFixture(fixture)).resolves.toStrictEqual(
      expect.objectContaining({
        modelProvider: "vm0",
        selectedModel: "claude-sonnet-4-6",
      }),
    );
  });

  it("starts a new custom DM session when the default model provider changed", async () => {
    const fixture = await trackFixture(
      seedTelegramPostFixture({ linkTelegramUser: true }),
    );
    await seedModelPolicies({
      fixture,
      selectedModel: null,
    });
    await seedOrgCredits(fixture, 100_000);
    const previousSessionId = await seedCompletedRun({
      fixture,
      modelProvider: "openrouter-api-key",
      selectedModel: "claude-sonnet-4-6",
    });
    await seedTelegramThreadSession({
      fixture,
      telegramUserLinkId: await linkedTelegramUserLinkId(fixture),
      chatId: fixture.telegramUserId!,
      rootMessageId: "dm",
      agentSessionId: previousSessionId,
    });
    const telegramMocks = telegramApiMocks();

    const response = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 133,
        message: {
          message_id: 1331,
          chat: { id: Number(fixture.telegramUserId), type: "private" },
          from: {
            id: Number(fixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
          },
          text: "default provider changed telegram session",
        },
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages).toStrictEqual([]);

    const run = await runForFixturePrompt(
      fixture,
      "default provider changed telegram session",
    );
    expect(run?.prompt).toBe("default provider changed telegram session");
    expect(run?.continuedFromSessionId).toBeNull();
    expect(run?.sessionId).not.toBe(previousSessionId);
    await expect(latestZeroRunForFixture(fixture)).resolves.toStrictEqual(
      expect.objectContaining({
        modelProvider: "vm0",
        selectedModel: "claude-sonnet-4-6",
      }),
    );
  });
});
