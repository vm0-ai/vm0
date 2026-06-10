import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { OFFICIAL_TELEGRAM_BOT_ID } from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramMessages } from "@vm0/db/schema/telegram-message";
import { telegramOfficialUserLinks } from "@vm0/db/schema/telegram-official-user-link";
import { telegramThreadSessions } from "@vm0/db/schema/telegram-thread-session";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { clearMockedEnv, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { seedAgentRunCallback$ } from "./helpers/agent-run-callback";
import { encryptSecretForTests } from "./helpers/encrypt-secret";
import { createFixtureTracker } from "./helpers/zero-route-test";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();

const PATH = "/api/internal/callbacks/telegram";
const TEST_CALLBACK_SECRET = "test-callback-secret";
const TEST_BOT_TOKEN = "test-bot-token";
const OFFICIAL_BOT_TOKEN = "123456:official-test-token";

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

async function deleteFixture(fixture: TelegramFixture): Promise<void> {
  const db = store.set(writeDb$);
  await db
    .delete(telegramThreadSessions)
    .where(eq(telegramThreadSessions.telegramUserLinkId, fixture.userLinkId));
  await db
    .delete(telegramMessages)
    .where(eq(telegramMessages.installationId, fixture.installationId));
  await db
    .delete(telegramMessages)
    .where(eq(telegramMessages.officialOrgId, fixture.orgId));
  await db
    .delete(telegramUserLinks)
    .where(eq(telegramUserLinks.id, fixture.userLinkId));
  await db
    .delete(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, fixture.installationId));
  await db
    .delete(telegramOfficialUserLinks)
    .where(
      and(
        eq(telegramOfficialUserLinks.orgId, fixture.orgId),
        eq(telegramOfficialUserLinks.vm0UserId, fixture.userId),
      ),
    );
  await db
    .delete(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, fixture.orgId),
        eq(userFeatureSwitches.userId, fixture.userId),
      ),
    );
  await db
    .delete(modelProviders)
    .where(eq(modelProviders.orgId, fixture.orgId));
  await store.set(deleteUsageInsightFixture$, fixture, context.signal);
}

async function seedTelegramInstallation(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
}): Promise<{ readonly installationId: string; readonly userLinkId: string }> {
  const db = store.set(writeDb$);
  const installationId = `bot-${randomUUID()}`;
  await db.insert(telegramInstallations).values({
    telegramBotId: installationId,
    botUsername: `bot_${installationId.slice(4, 12)}`,
    encryptedBotToken: encryptSecretForTests(TEST_BOT_TOKEN),
    webhookSecret: `whs_${randomUUID()}`,
    defaultComposeId: args.composeId,
    ownerUserId: args.userId,
    orgId: args.orgId,
  });
  const [userLink] = await db
    .insert(telegramUserLinks)
    .values({
      installationId,
      telegramUserId: `tg-${randomUUID()}`,
      telegramUsername: "alice",
      telegramDisplayName: "Alice",
      vm0UserId: args.userId,
    })
    .returning({ id: telegramUserLinks.id });
  if (!userLink) {
    throw new Error(
      "seedTelegramInstallation: user link insert returned no row",
    );
  }
  return { installationId, userLinkId: userLink.id };
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
  const { callbackId } = await store.set(
    seedAgentRunCallback$,
    {
      runId,
      url: `http://localhost${PATH}`,
      payload: payload as unknown as Record<string, unknown>,
    },
    context.signal,
  );

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
  const { callbackId } = await store.set(
    seedAgentRunCallback$,
    {
      runId,
      url: `http://localhost${PATH}`,
      payload: payload as unknown as Record<string, unknown>,
    },
    context.signal,
  );

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

function signedHeaders(
  rawBody: string,
  secret = TEST_CALLBACK_SECRET,
  timestamp = Math.floor(now() / 1000),
) {
  return {
    "Content-Type": "application/json",
    "X-VM0-Signature": computeHmacSignature(rawBody, secret, timestamp),
    "X-VM0-Timestamp": String(timestamp),
  };
}

async function postSignedCallback(
  body: Record<string, unknown>,
  secret?: string,
  timestamp = Math.floor(now() / 1000),
): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const app = createApp({ signal: context.signal });
  return await app.request(PATH, {
    method: "POST",
    headers: signedHeaders(rawBody, secret, timestamp),
    body: rawBody,
  });
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
  const db = store.set(writeDb$);
  await db.insert(userFeatureSwitches).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    switches: { [FeatureSwitchKey.AuditLink]: true },
  });
}

async function findThreadSession(args: {
  readonly userLinkId: string;
  readonly chatId: string;
  readonly rootMessageId: string;
}): Promise<{ readonly agentSessionId: string } | null> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({ agentSessionId: telegramThreadSessions.agentSessionId })
    .from(telegramThreadSessions)
    .where(
      and(
        eq(telegramThreadSessions.telegramUserLinkId, args.userLinkId),
        eq(telegramThreadSessions.chatId, args.chatId),
        eq(telegramThreadSessions.rootMessageId, args.rootMessageId),
      ),
    )
    .limit(1);
  return row ?? null;
}

afterEach(() => {
  context.mocks.axiom.query.mockReset();
  clearMockedEnv();
});

describe("POST /api/internal/callbacks/telegram", () => {
  const track = createFixtureTracker<TelegramFixture>((fixture) => {
    return deleteFixture(fixture);
  });

  it("rejects requests with invalid signatures", async () => {
    const fixture = await track(seedFixture());

    const response = await postSignedCallback(
      {
        callbackId: fixture.callbackId,
        runId: fixture.runId,
        status: "completed",
        payload: fixture.payload,
      },
      "wrong-secret",
    );

    expect(response.status).toBe(401);
  });

  it("rejects requests with expired timestamps", async () => {
    const fixture = await track(seedFixture());
    const expiredTimestamp = Math.floor(now() / 1000) - 10 * 60;

    const response = await postSignedCallback(
      {
        callbackId: fixture.callbackId,
        runId: fixture.runId,
        status: "completed",
        payload: fixture.payload,
      },
      TEST_CALLBACK_SECRET,
      expiredTimestamp,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Timestamp expired",
    });
  });

  it("returns 404 for callbacks without a matching callback record", async () => {
    const response = await postSignedCallback({
      runId: randomUUID(),
      status: "completed",
      payload: {
        installationId: "missing-installation",
        chatId: "12345",
        messageId: "42",
        rootMessageId: "100",
        userLinkId: "missing-link",
        agentId: "missing-agent",
        existingSessionId: null,
        isDM: false,
      },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Callback not found",
    });
  });

  it("rejects callbacks with missing runId", async () => {
    const response = await postSignedCallback({
      status: "completed",
      payload: {
        installationId: "missing-installation",
        chatId: "12345",
        messageId: "42",
        rootMessageId: "100",
        userLinkId: "missing-link",
        agentId: "missing-agent",
        existingSessionId: null,
        isDM: false,
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Missing runId",
    });
  });

  it("rejects invalid payloads after callback verification", async () => {
    const fixture = await track(seedFixture());

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { installationId: fixture.installationId },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Invalid or missing payload",
    });
  });

  it("refreshes typing for progress callbacks without sending a message", async () => {
    const fixture = await track(seedFixture());
    const telegram = telegramApiMocks();

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "progress",
      payload: { ...fixture.payload, thinkingMessageId: "100" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    expect(telegram.chatActions).toHaveLength(1);
    expect(telegram.deleteMessages).toHaveLength(0);
    expect(telegram.sentMessages).toHaveLength(0);
  });

  it("renders completed output as Telegram HTML and stores the bot reply", async () => {
    const fixture = await track(seedFixture());
    const telegram = telegramApiMocks();
    completedOutput();

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: fixture.payload,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    expect(telegram.sentMessages).toHaveLength(1);
    expect(telegram.sentMessages[0]).toMatchObject({
      chat_id: fixture.payload.chatId,
      parse_mode: "HTML",
      reply_parameters: { message_id: Number(fixture.payload.messageId) },
    });
    expect(telegram.sentMessages[0]?.text).toContain(
      "<b>Done</b> with <code>code</code>",
    );

    const db = store.set(writeDb$);
    const [stored] = await db
      .select({ text: telegramMessages.text, isBot: telegramMessages.isBot })
      .from(telegramMessages)
      .where(eq(telegramMessages.installationId, fixture.installationId))
      .limit(1);
    expect(stored).toStrictEqual({
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

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: fixture.payload,
    });

    expect(response.status).toBe(200);
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

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: fixture.payload,
    });

    expect(response.status).toBe(200);
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
    const db = store.set(writeDb$);
    await enableAuditLink(fixture);
    await db
      .update(zeroRuns)
      .set({ selectedModel: "claude-opus-4-7" })
      .where(eq(zeroRuns.id, fixture.runId));
    const telegram = telegramApiMocks();
    mockEnv("APP_URL", "https://app.vm0.test");
    completedOutput("Plain result");

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: fixture.payload,
    });

    expect(response.status).toBe(200);
    const text = telegram.sentMessages[0]?.text ?? "";
    expect(text).toContain("📋 Audit");
    expect(text).toContain(`https://app.vm0.test/activities/${fixture.runId}`);
    expect(text).toContain("Claude Opus 4.7");
    expect(text).not.toContain("Responded by");
  });

  it("renders responded-by and selected-model footer text for non-default agent replies", async () => {
    const fixture = await track(seedResponderFixture());
    const db = store.set(writeDb$);
    await db
      .update(zeroRuns)
      .set({ selectedModel: "claude-opus-4-7" })
      .where(eq(zeroRuns.id, fixture.runId));
    const telegram = telegramApiMocks();
    completedOutput("Responder result");

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: fixture.payload,
    });

    expect(response.status).toBe(200);
    const text = telegram.sentMessages[0]?.text ?? "";
    expect(text).toContain("<i>Responded by Responder · Claude Opus 4.7</i>");
  });

  it("deletes legacy thinking placeholders and formats generic failed callbacks like Web", async () => {
    const fixture = await track(seedFixture());
    const telegram = telegramApiMocks();

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "failed",
      error: "请先 [连接 Notion](https://example.com/connect?agentId=123)",
      payload: { ...fixture.payload, thinkingMessageId: "100" },
    });

    expect(response.status).toBe(200);
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

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "failed",
      error: "Cannot continue session from checkpoint",
      payload: fixture.payload,
    });

    expect(response.status).toBe(200);
    const text = telegram.sentMessages[0]?.text ?? "";
    expect(text).not.toContain("Agent Execution Error");
    expect(text).toContain("Cannot continue session from checkpoint");
  });

  it("does not quote DM replies and replaces the DM thread mapping", async () => {
    const fixture = await track(seedFixture());
    const db = store.set(writeDb$);
    const [run] = await db
      .select({ sessionId: agentRuns.sessionId })
      .from(agentRuns)
      .where(eq(agentRuns.id, fixture.runId))
      .limit(1);
    if (!run) {
      throw new Error("Expected seeded run");
    }
    const [oldSession] = await db
      .insert(agentSessions)
      .values({
        userId: fixture.userId,
        orgId: fixture.orgId,
        agentComposeId: fixture.composeId,
      })
      .returning({ id: agentSessions.id });
    if (!oldSession) {
      throw new Error("Expected old session");
    }
    await db.insert(telegramThreadSessions).values({
      telegramUserLinkId: fixture.userLinkId,
      chatId: fixture.payload.chatId,
      rootMessageId: "dm",
      agentSessionId: oldSession.id,
    });
    const telegram = telegramApiMocks();
    completedOutput("DM result");

    const response = await postSignedCallback({
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

    expect(response.status).toBe(200);
    expect(telegram.sentMessages[0]?.reply_parameters).toBeUndefined();
    const session = await findThreadSession({
      userLinkId: fixture.userLinkId,
      chatId: fixture.payload.chatId,
      rootMessageId: "dm",
    });
    expect(session?.agentSessionId).toBe(run.sessionId);
    expect(session?.agentSessionId).not.toBe(oldSession.id);
  });

  it("uses the official bot token and official message scope", async () => {
    const fixture = await track(seedFixture());
    const db = store.set(writeDb$);
    const [officialLink] = await db
      .insert(telegramOfficialUserLinks)
      .values({
        orgId: fixture.orgId,
        vm0UserId: fixture.userId,
        telegramUserId: `tg-${randomUUID()}`,
      })
      .returning({ id: telegramOfficialUserLinks.id });
    if (!officialLink) {
      throw new Error("Expected official user link");
    }
    mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", OFFICIAL_BOT_TOKEN);
    mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", "zerobot");
    mockEnv("TELEGRAM_OFFICIAL_WEBHOOK_SECRET", "official-secret");
    const telegram = telegramApiMocks(OFFICIAL_BOT_TOKEN);
    completedOutput("Official result");

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: {
        ...fixture.payload,
        installationId: OFFICIAL_TELEGRAM_BOT_ID,
        userLinkId: officialLink.id,
      },
    });

    expect(response.status).toBe(200);
    expect(telegram.sentMessages).toHaveLength(1);
    const [stored] = await db
      .select({
        officialOrgId: telegramMessages.officialOrgId,
        officialUserLinkId: telegramMessages.officialUserLinkId,
      })
      .from(telegramMessages)
      .where(eq(telegramMessages.officialOrgId, fixture.orgId))
      .limit(1);
    expect(stored).toStrictEqual({
      officialOrgId: fixture.orgId,
      officialUserLinkId: officialLink.id,
    });
  });

  it("returns success without side effects when the installation is missing", async () => {
    const fixture = await track(seedFixture());
    const telegram = telegramApiMocks();

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: {
        ...fixture.payload,
        installationId: "missing-installation",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    expect(telegram.sentMessages).toHaveLength(0);
  });
});
