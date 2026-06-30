import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { OFFICIAL_TELEGRAM_BOT_ID } from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import type {
  TestTelegramStateActionBody,
  TestTelegramStateActionResponse,
  TestTelegramStateResponse,
} from "@vm0/api-contracts/contracts/test-telegram-state";

import { createAppWithRoutes } from "../../../app-factory-core";
import { testContext } from "../../../__tests__/test-context";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { clearMockedEnv, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { testTelegramStateRoutes } from "../test-telegram-state";
import { zeroIntegrationsTelegramRoutes } from "../zero-integrations-telegram";
import { createFixtureTracker } from "./helpers/zero-route-test";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/zero-feature-switches";
import { seedTelegramUserLink$ } from "./helpers/zero-telegram";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();

const TEST_BOT_TOKEN = "test-bot-token";
const OFFICIAL_BOT_TOKEN = "123456:official-test-token";
const CALLBACK_SECRET = "test-callback-secret";
const TELEGRAM_CALLBACK_ROUTE = "/api/internal/callbacks/telegram";
const TELEGRAM_STATE_ROUTE = "/api/test/telegram-state";
const TELEGRAM_STATE_ACTION_ROUTE = "/api/test/telegram-state/action";
const telegramRoutes = [
  ...zeroIntegrationsTelegramRoutes,
  ...testTelegramStateRoutes,
] as const;

type TelegramCallbackStatus = "completed" | "failed" | "progress";

interface TelegramCallbackPayload {
  readonly installationId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly rootMessageId?: string | null;
  readonly userLinkId: string;
  readonly agentId: string;
  readonly existingSessionId?: string | null;
  readonly isDM: boolean;
  readonly thinkingMessageId?: string | null;
}

interface TelegramFixture extends UsageInsightFixture {
  readonly composeId: string;
  readonly installationId: string;
  readonly userLinkId: string;
  readonly runId: string;
  readonly callbackId: string;
  readonly payload: TelegramCallbackPayload;
}

interface TelegramSendMessageBody {
  readonly chat_id: string;
  readonly text: string;
  readonly parse_mode?: string;
  readonly reply_parameters?: { readonly message_id: number };
}

interface TelegramStateMessage {
  readonly text: string;
  readonly isBot: boolean;
  readonly officialOrgId?: string | null;
  readonly officialUserLinkId?: string | null;
}

interface TelegramStateRun {
  readonly session_id: string | null;
  readonly selected_model: string | null;
}

function telegramApiMocks(token = TEST_BOT_TOKEN): {
  readonly chatActions: unknown[];
  readonly deleteMessages: unknown[];
  readonly sentMessages: TelegramSendMessageBody[];
} {
  const chatActions: unknown[] = [];
  const deleteMessages: unknown[] = [];
  const sentMessages: TelegramSendMessageBody[] = [];
  let nextMessageId = 900;

  server.use(
    http.post(
      `https://api.telegram.org/bot${token}/sendChatAction`,
      async ({ request }) => {
        chatActions.push(await request.json());
        return HttpResponse.json({ ok: true, result: true });
      },
    ),
    http.post(
      `https://api.telegram.org/bot${token}/deleteMessage`,
      async ({ request }) => {
        deleteMessages.push(await request.json());
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

  return { chatActions, deleteMessages, sentMessages };
}

function requestApp(path: string, init?: RequestInit): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: telegramRoutes,
  });
  return Promise.resolve(app.request(path, init));
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

async function postTelegramStateAction(
  body: TestTelegramStateActionBody,
): Promise<TestTelegramStateActionResponse> {
  const response = await requestApp(TELEGRAM_STATE_ACTION_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await expectOk(response, `telegram state action ${body.action}`);
  return await readJson<TestTelegramStateActionResponse>(response);
}

async function readTelegramState(
  botId: string,
): Promise<TestTelegramStateResponse> {
  const response = await requestApp(
    `${TELEGRAM_STATE_ROUTE}?bot_id=${encodeURIComponent(botId)}`,
  );
  await expectOk(response, "read telegram state");
  return await readJson<TestTelegramStateResponse>(response);
}

function stateMessages(
  state: TestTelegramStateResponse,
): TelegramStateMessage[] {
  return state.messages.filter((value): value is TelegramStateMessage => {
    return (
      typeof value === "object" &&
      value !== null &&
      "text" in value &&
      "isBot" in value
    );
  });
}

function officialStateMessages(
  state: TestTelegramStateResponse,
): TelegramStateMessage[] {
  return state.official_messages.filter(
    (value): value is TelegramStateMessage => {
      return (
        typeof value === "object" &&
        value !== null &&
        "officialOrgId" in value &&
        "officialUserLinkId" in value
      );
    },
  );
}

async function deleteFixture(fixture: TelegramFixture): Promise<void> {
  await postTelegramStateAction({
    action: "delete-fixture",
    org_id: fixture.orgId,
    compose_ids: [fixture.composeId],
    telegram_bot_ids: [fixture.installationId],
  });
  await deleteFeatureSwitchesForUser(context, fixture);
  await store.set(deleteUsageInsightFixture$, fixture, context.signal);
}

async function seedTelegramInstallation(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
}): Promise<{ readonly installationId: string; readonly userLinkId: string }> {
  const installationId = `bot-${randomUUID()}`;
  await postTelegramStateAction({
    action: "seed-installation",
    org_id: args.orgId,
    owner_user_id: args.userId,
    telegram_bot_id: installationId,
    bot_username: `bot_${installationId.slice(4, 12)}`,
    bot_token: TEST_BOT_TOKEN,
    default_compose_id: args.composeId,
    skip_compose: true,
  });
  const userLink = await store.set(
    seedTelegramUserLink$,
    {
      installationId,
      telegramUserId: `tg-${randomUUID()}`,
      telegramUsername: "alice",
      telegramDisplayName: "Alice",
      vm0UserId: args.userId,
    },
    context.signal,
  );
  if (!userLink.userLinkId) {
    throw new Error("seedTelegramInstallation: response missing user link id");
  }
  return { installationId, userLinkId: userLink.userLinkId };
}

async function seedTelegramCallback(args: {
  readonly runId: string;
  readonly payload: TelegramCallbackPayload;
}): Promise<{ readonly callbackId: string }> {
  const response = await postTelegramStateAction({
    action: "seed-agent-run-callback",
    run_id: args.runId,
    url: `http://localhost${TELEGRAM_CALLBACK_ROUTE}`,
    internal_kind: "telegram",
    payload: args.payload as unknown as Record<string, unknown>,
    secret: CALLBACK_SECRET,
  });
  const callbackId =
    typeof response.callback_id === "string" ? response.callback_id : null;
  if (!callbackId) {
    throw new Error("seedTelegramCallback: response missing callback_id");
  }
  return { callbackId };
}

async function seedFixture(): Promise<TelegramFixture> {
  const base = await store.set(
    seedUsageInsightFixture$,
    undefined,
    context.signal,
  );
  const { composeId } = await store.set(
    seedCompose$,
    {
      orgId: base.orgId,
      userId: base.userId,
      name: `telegram-callback-${randomUUID().slice(0, 8)}`,
      displayName: "Telegram Agent",
    },
    context.signal,
  );
  const { installationId, userLinkId } = await seedTelegramInstallation({
    orgId: base.orgId,
    userId: base.userId,
    composeId,
  });
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: base.orgId,
      userId: base.userId,
      composeId,
      triggerSource: "telegram",
      prompt: "Handle Telegram message",
      lastEventSequence: 0,
    },
    context.signal,
  );
  const payload: TelegramCallbackPayload = {
    installationId,
    chatId: "12345",
    messageId: "42",
    rootMessageId: "100",
    userLinkId,
    agentId: composeId,
    existingSessionId: null,
    isDM: false,
  };
  const { callbackId } = await seedTelegramCallback({ runId, payload });

  return {
    ...base,
    composeId,
    installationId,
    userLinkId,
    runId,
    callbackId,
    payload,
  };
}

async function seedResponderFixture(): Promise<TelegramFixture> {
  const base = await store.set(
    seedUsageInsightFixture$,
    undefined,
    context.signal,
  );
  const { composeId: defaultComposeId } = await store.set(
    seedCompose$,
    {
      orgId: base.orgId,
      userId: base.userId,
      name: `telegram-default-${randomUUID().slice(0, 8)}`,
      displayName: "Default Agent",
    },
    context.signal,
  );
  const { composeId: responderComposeId } = await store.set(
    seedCompose$,
    {
      orgId: base.orgId,
      userId: base.userId,
      name: `telegram-responder-${randomUUID().slice(0, 8)}`,
      displayName: "Responder",
    },
    context.signal,
  );
  const { installationId, userLinkId } = await seedTelegramInstallation({
    orgId: base.orgId,
    userId: base.userId,
    composeId: defaultComposeId,
  });
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: base.orgId,
      userId: base.userId,
      composeId: responderComposeId,
      triggerSource: "telegram",
      prompt: "Handle Telegram responder message",
      lastEventSequence: 0,
    },
    context.signal,
  );
  const payload: TelegramCallbackPayload = {
    installationId,
    chatId: "12345",
    messageId: "42",
    rootMessageId: "100",
    userLinkId,
    agentId: responderComposeId,
    existingSessionId: null,
    isDM: false,
  };
  const { callbackId } = await seedTelegramCallback({ runId, payload });

  return {
    ...base,
    composeId: responderComposeId,
    installationId,
    userLinkId,
    runId,
    callbackId,
    payload,
  };
}

async function dispatchTelegramCallback(body: {
  readonly callbackId?: string;
  readonly runId: string;
  readonly status: TelegramCallbackStatus;
  readonly error?: string;
  readonly payload: unknown;
}) {
  const rawBody = JSON.stringify(body);
  const response = await requestApp(TELEGRAM_CALLBACK_ROUTE, {
    method: "POST",
    headers: signedHeaders(rawBody),
    body: rawBody,
  });
  const responseBody = (await response.json()) as unknown;
  if (response.ok) {
    return responseBody;
  }
  const errorBody =
    typeof responseBody === "object" && responseBody !== null
      ? (responseBody as Record<string, unknown>)
      : {};
  return {
    success: false,
    status: response.status,
    ...errorBody,
  };
}

function completedOutput(text = "**Done** with `code`"): void {
  context.mocks.axiom.query.mockResolvedValueOnce([
    {
      eventType: "result",
      eventData: { result: text },
    },
  ]);
}

async function enableAuditLink(fixture: TelegramFixture): Promise<void> {
  await updateFeatureSwitchesForUser(context, fixture, {
    [FeatureSwitchKey.ZeroDebug]: true,
  });
}

async function findThreadSession(args: {
  readonly userLinkId: string;
  readonly chatId: string;
  readonly rootMessageId: string;
}): Promise<{ readonly agentSessionId: string } | null> {
  const response = await postTelegramStateAction({
    action: "find-thread-session",
    user_link_id: args.userLinkId,
    chat_id: args.chatId,
    root_message_id: args.rootMessageId,
  });
  const threadSession =
    typeof response.thread_session === "object" &&
    response.thread_session !== null
      ? (response.thread_session as Record<string, unknown>)
      : null;
  const agentSessionId =
    typeof threadSession?.agent_session_id === "string"
      ? threadSession.agent_session_id
      : null;
  return agentSessionId ? { agentSessionId } : null;
}

afterEach(() => {
  context.mocks.axiom.query.mockReset();
  clearMockedEnv();
});

describe("POST /api/internal/callbacks/telegram", () => {
  const track = createFixtureTracker<TelegramFixture>((fixture) => {
    return deleteFixture(fixture);
  });

  it("rejects invalid payloads", async () => {
    const fixture = await track(seedFixture());

    const result = await dispatchTelegramCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { installationId: fixture.installationId },
    });

    expect(result).toStrictEqual({
      success: false,
      status: 400,
      error: "Invalid or missing payload",
    });
  });

  it("refreshes typing for progress callbacks without sending a message", async () => {
    const fixture = await track(seedFixture());
    const telegram = telegramApiMocks();

    const result = await dispatchTelegramCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "progress",
      payload: { ...fixture.payload, thinkingMessageId: "100" },
    });

    expect(result).toStrictEqual({ success: true });
    expect(telegram.chatActions).toHaveLength(1);
    expect(telegram.deleteMessages).toHaveLength(0);
    expect(telegram.sentMessages).toHaveLength(0);
  });

  it("renders completed output as Telegram HTML and stores the bot reply", async () => {
    const fixture = await track(seedFixture());
    const telegram = telegramApiMocks();
    completedOutput();

    const result = await dispatchTelegramCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: fixture.payload,
    });

    expect(result).toStrictEqual({ success: true });
    expect(telegram.sentMessages).toHaveLength(1);
    expect(telegram.sentMessages[0]).toMatchObject({
      chat_id: fixture.payload.chatId,
      parse_mode: "HTML",
      reply_parameters: { message_id: Number(fixture.payload.messageId) },
    });
    expect(telegram.sentMessages[0]?.text).toContain(
      "<b>Done</b> with <code>code</code>",
    );

    const state = await readTelegramState(fixture.installationId);
    const [stored] = stateMessages(state);
    expect(stored).toMatchObject({
      text: "**Done** with `code`",
      isBot: true,
    });
  });

  it("renders markdown links in completed replies", async () => {
    const fixture = await track(seedFixture());
    const telegram = telegramApiMocks();
    completedOutput(
      "Please [connect Notion](https://example.com/connect?agentId=123)",
    );

    const result = await dispatchTelegramCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: fixture.payload,
    });

    expect(result).toStrictEqual({ success: true });
    const text = telegram.sentMessages[0]?.text ?? "";
    expect(telegram.sentMessages[0]?.parse_mode).toBe("HTML");
    expect(text).toContain(
      '<a href="https://example.com/connect?agentId=123">connect Notion</a>',
    );
    expect(text).not.toContain("[connect Notion](");
  });

  it("sends completed replies through the preview Telegram mock when enabled", async () => {
    const fixture = await track(seedFixture());
    const calls: {
      readonly headers: Headers;
      readonly body: TelegramSendMessageBody;
    }[] = [];
    mockOptionalEnv("E2E_TELEGRAM_MOCK_ENABLED", "1");
    mockOptionalEnv("VERCEL_URL", "preview.example.test");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
    server.use(
      http.post(
        `https://preview.example.test/api/test/telegram-mock/bot${TEST_BOT_TOKEN}/sendChatAction`,
        () => {
          return HttpResponse.json({ ok: true, result: true });
        },
      ),
      http.post(
        `https://preview.example.test/api/test/telegram-mock/bot${TEST_BOT_TOKEN}/sendMessage`,
        async ({ request }) => {
          const body = (await request.json()) as TelegramSendMessageBody;
          calls.push({ headers: request.headers, body });
          return HttpResponse.json({
            ok: true,
            result: {
              message_id: 901,
              chat: { id: Number(body.chat_id) },
              text: body.text,
            },
          });
        },
      ),
    );
    completedOutput("Mocked preview reply");

    const result = await dispatchTelegramCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: fixture.payload,
    });

    expect(result).toStrictEqual({ success: true });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    if (!call) {
      throw new Error("Expected preview Telegram mock call");
    }
    expect(call.body).toMatchObject({
      chat_id: fixture.payload.chatId,
      text: "Mocked preview reply",
      parse_mode: "HTML",
      reply_parameters: { message_id: Number(fixture.payload.messageId) },
    });
    expect(call.headers.get("x-vercel-protection-bypass")).toBe(
      "preview-secret",
    );
    expect(call.headers.get("x-vm0-test-endpoint-bypass")).toBe(
      "preview-secret",
    );
  });

  it("includes audit links and agent reply footer text when configured", async () => {
    const fixture = await track(seedFixture());
    await enableAuditLink(fixture);
    await postTelegramStateAction({
      action: "update-run",
      run_id: fixture.runId,
      selected_model: "claude-opus-4-7",
    });
    const telegram = telegramApiMocks();
    mockEnv("APP_URL", "https://app.vm0.test");
    completedOutput("Plain result");

    const result = await dispatchTelegramCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: fixture.payload,
    });

    expect(result).toStrictEqual({ success: true });
    const text = telegram.sentMessages[0]?.text ?? "";
    expect(text).toContain("📋 Audit");
    expect(text).toContain(`https://app.vm0.test/activities/${fixture.runId}`);
    expect(text).toContain("Claude Opus 4.7");
    expect(text).not.toContain("Responded by");
  });

  it("renders responded-by and selected-model footer text for non-default agent replies", async () => {
    const fixture = await track(seedResponderFixture());
    await postTelegramStateAction({
      action: "update-run",
      run_id: fixture.runId,
      selected_model: "claude-opus-4-7",
    });
    const telegram = telegramApiMocks();
    completedOutput("Responder result");

    const result = await dispatchTelegramCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: fixture.payload,
    });

    expect(result).toStrictEqual({ success: true });
    const text = telegram.sentMessages[0]?.text ?? "";
    expect(text).toContain("<i>Responded by Responder · Claude Opus 4.7</i>");
  });

  it("deletes legacy thinking placeholders and formats generic failed callbacks like Web", async () => {
    const fixture = await track(seedFixture());
    const telegram = telegramApiMocks();

    const result = await dispatchTelegramCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "failed",
      error: "请先 [连接 Notion](https://example.com/connect?agentId=123)",
      payload: { ...fixture.payload, thinkingMessageId: "100" },
    });

    expect(result).toStrictEqual({ success: true });
    expect(telegram.deleteMessages).toHaveLength(1);
    const text = telegram.sentMessages[0]?.text ?? "";
    expect(text).not.toContain("Agent Execution Error");
    expect(text).toContain(
      "Oops, something went wrong. Please try again later.",
    );
    expect(text).not.toContain("连接 Notion");
  });

  it("preserves actionable failed callback errors like Web", async () => {
    const fixture = await track(seedFixture());
    const telegram = telegramApiMocks();

    const result = await dispatchTelegramCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "failed",
      error: "Cannot continue session from checkpoint",
      payload: fixture.payload,
    });

    expect(result).toStrictEqual({ success: true });
    const text = telegram.sentMessages[0]?.text ?? "";
    expect(text).not.toContain("Agent Execution Error");
    expect(text).toContain("Cannot continue session from checkpoint");
  });

  it("does not quote DM replies and replaces the DM thread mapping", async () => {
    const fixture = await track(seedFixture());
    const runResponse = await postTelegramStateAction({
      action: "get-run",
      run_id: fixture.runId,
    });
    const run =
      typeof runResponse.run === "object" && runResponse.run !== null
        ? (runResponse.run as TelegramStateRun)
        : null;
    if (!run?.session_id) {
      throw new Error("Expected seeded run");
    }
    const oldSession = await postTelegramStateAction({
      action: "seed-thread-session",
      user_link_id: fixture.userLinkId,
      chat_id: fixture.payload.chatId,
      root_message_id: "dm",
      org_id: fixture.orgId,
      user_id: fixture.userId,
      compose_id: fixture.composeId,
    });
    const oldSessionId =
      typeof oldSession.agent_session_id === "string"
        ? oldSession.agent_session_id
        : null;
    if (!oldSessionId) {
      throw new Error("Expected old session");
    }
    const telegram = telegramApiMocks();
    completedOutput("DM result");

    const result = await dispatchTelegramCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: {
        ...fixture.payload,
        rootMessageId: "dm",
        existingSessionId: null,
        isDM: true,
      },
    });

    expect(result).toStrictEqual({ success: true });
    expect(telegram.sentMessages[0]?.reply_parameters).toBeUndefined();
    const session = await findThreadSession({
      userLinkId: fixture.userLinkId,
      chatId: fixture.payload.chatId,
      rootMessageId: "dm",
    });
    expect(session?.agentSessionId).toBe(run.session_id);
    expect(session?.agentSessionId).not.toBe(oldSessionId);
  });

  it("uses the official bot token and official message scope", async () => {
    const fixture = await track(seedFixture());
    const officialLink = await postTelegramStateAction({
      action: "seed-official-user-link",
      org_id: fixture.orgId,
      user_id: fixture.userId,
      telegram_user_id: `tg-${randomUUID()}`,
    });
    const officialLinkId =
      typeof officialLink.user_link_id === "string"
        ? officialLink.user_link_id
        : null;
    if (!officialLinkId) {
      throw new Error("Expected official user link");
    }
    mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", OFFICIAL_BOT_TOKEN);
    mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", "zerobot");
    mockEnv("TELEGRAM_OFFICIAL_WEBHOOK_SECRET", "official-secret");
    const telegram = telegramApiMocks(OFFICIAL_BOT_TOKEN);
    completedOutput("Official result");

    const result = await dispatchTelegramCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: {
        ...fixture.payload,
        installationId: OFFICIAL_TELEGRAM_BOT_ID,
        userLinkId: officialLinkId,
      },
    });

    expect(result).toStrictEqual({ success: true });
    expect(telegram.sentMessages).toHaveLength(1);
    const state = await readTelegramState(fixture.installationId);
    const [stored] = officialStateMessages(state);
    expect(stored).toMatchObject({
      officialOrgId: fixture.orgId,
      officialUserLinkId: officialLinkId,
    });
  });

  it("returns success without side effects when the installation is missing", async () => {
    const fixture = await track(seedFixture());
    const telegram = telegramApiMocks();

    const result = await dispatchTelegramCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: {
        ...fixture.payload,
        installationId: "missing-installation",
      },
    });

    expect(result).toStrictEqual({ success: true });
    expect(telegram.sentMessages).toHaveLength(0);
  });
});
