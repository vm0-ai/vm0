import { randomUUID } from "node:crypto";

import { zeroIntegrationsTelegramContract } from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import {
  agentComposeVersions,
  agentComposes,
} from "@vm0/db/schema/agent-compose";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramMessages } from "@vm0/db/schema/telegram-message";
import { telegramOfficialUserLinks } from "@vm0/db/schema/telegram-official-user-link";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { command, createStore } from "ccstate";
import { and, desc, eq, inArray } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockedEnv, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { clearAllDetached } from "../../utils";
import { encryptSecretForTests } from "./helpers/encrypt-secret";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const TEST_BOT_TOKEN = "123456:test-bot-token";
const OFFICIAL_BOT_TOKEN = "987654:official-bot-token";
const OFFICIAL_BOT_USERNAME = "official_zero_bot";
const OFFICIAL_WEBHOOK_SECRET = "official-webhook-secret";

interface TelegramPostFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly telegramBotId: string;
  readonly webhookSecret: string;
  readonly telegramUserId?: string;
}

interface TelegramSendMessageBody {
  readonly chat_id: string;
  readonly text: string;
  readonly parse_mode?: string;
  readonly reply_to_message_id?: number;
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

const seedTelegramPostFixture$ = command(
  async (
    { set },
    args: {
      readonly orgId?: string;
      readonly userId?: string;
      readonly telegramBotId?: string;
      readonly installBot?: boolean;
      readonly linkTelegramUser?: boolean;
      readonly seedOfficialLink?: boolean;
      readonly seedDefaultAgent?: boolean;
    },
    signal: AbortSignal,
  ): Promise<TelegramPostFixture> => {
    const db = set(writeDb$);
    const orgId = args.orgId ?? `org_${randomUUID().slice(0, 8)}`;
    const userId = args.userId ?? `user_${randomUUID().slice(0, 8)}`;
    const composeId = randomUUID();
    const versionId = randomUUID();
    const telegramBotId = args.telegramBotId ?? newTelegramBotId();
    const webhookSecret = `whs_${randomUUID()}`;
    const name = `telegram-agent-${composeId.slice(0, 8)}`;

    await db.insert(agentComposes).values({
      id: composeId,
      userId,
      orgId,
      name,
    });
    signal.throwIfAborted();
    await db.insert(agentComposeVersions).values({
      id: versionId,
      composeId,
      content: {
        version: "1.0",
        agents: {
          telegram: {
            framework: "claude-code",
            environment: { ANTHROPIC_API_KEY: "test-key" },
          },
        },
      },
      createdBy: userId,
    });
    signal.throwIfAborted();
    await db
      .update(agentComposes)
      .set({ headVersionId: versionId })
      .where(eq(agentComposes.id, composeId));
    signal.throwIfAborted();
    await db.insert(zeroAgents).values({
      id: composeId,
      orgId,
      owner: userId,
      name,
      displayName: "Telegram Agent",
      visibility: "public",
    });
    signal.throwIfAborted();

    if (args.seedDefaultAgent ?? true) {
      await db
        .insert(orgMetadata)
        .values({ orgId, defaultAgentId: composeId })
        .onConflictDoUpdate({
          target: orgMetadata.orgId,
          set: { defaultAgentId: composeId },
        });
      signal.throwIfAborted();
    }

    if (args.installBot ?? true) {
      await db.insert(telegramInstallations).values({
        telegramBotId,
        botUsername: `bot_${telegramBotId}`,
        encryptedBotToken: encryptSecretForTests(TEST_BOT_TOKEN),
        webhookSecret,
        defaultComposeId: composeId,
        ownerUserId: userId,
        orgId,
      });
      signal.throwIfAborted();
    }

    const telegramUserId = args.linkTelegramUser ? "99001" : undefined;
    if (telegramUserId) {
      await db.insert(telegramUserLinks).values({
        installationId: telegramBotId,
        telegramUserId,
        telegramUsername: "alice",
        telegramDisplayName: "Alice",
        vm0UserId: userId,
      });
      signal.throwIfAborted();
    }

    if (args.seedOfficialLink) {
      await db.insert(telegramOfficialUserLinks).values({
        orgId,
        vm0UserId: userId,
        telegramUserId: "99002",
        telegramUsername: "bob",
        telegramDisplayName: "Bob",
      });
      signal.throwIfAborted();
    }

    return {
      orgId,
      userId,
      composeId,
      telegramBotId,
      webhookSecret,
      telegramUserId,
    };
  },
);

async function deleteTelegramPostFixture(
  fixture: TelegramPostFixture,
): Promise<void> {
  const db = store.set(writeDb$);
  const runRows = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, fixture.orgId),
        eq(agentRuns.userId, fixture.userId),
      ),
    );
  const runIds = runRows.map((row) => {
    return row.id;
  });

  if (runIds.length > 0) {
    await db
      .delete(runnerJobQueue)
      .where(inArray(runnerJobQueue.runId, runIds));
    await db
      .delete(agentRunCallbacks)
      .where(inArray(agentRunCallbacks.runId, runIds));
    await db.delete(zeroRuns).where(inArray(zeroRuns.id, runIds));
    await db.delete(agentRuns).where(inArray(agentRuns.id, runIds));
  }

  await db
    .delete(agentSessions)
    .where(
      and(
        eq(agentSessions.orgId, fixture.orgId),
        eq(agentSessions.userId, fixture.userId),
      ),
    );
  await db
    .delete(telegramMessages)
    .where(eq(telegramMessages.installationId, fixture.telegramBotId));
  await db
    .delete(telegramMessages)
    .where(eq(telegramMessages.officialOrgId, fixture.orgId));
  await db
    .delete(telegramOfficialUserLinks)
    .where(eq(telegramOfficialUserLinks.orgId, fixture.orgId));
  await db
    .delete(telegramUserLinks)
    .where(eq(telegramUserLinks.installationId, fixture.telegramBotId));
  await db
    .delete(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, fixture.telegramBotId));
  await db.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
  await db
    .delete(agentComposeVersions)
    .where(eq(agentComposeVersions.composeId, fixture.composeId));
  await db.delete(zeroAgents).where(eq(zeroAgents.id, fixture.composeId));
  await db.delete(agentComposes).where(eq(agentComposes.id, fixture.composeId));
}

const trackFixture = createFixtureTracker<TelegramPostFixture>(
  deleteTelegramPostFixture,
);

beforeEach(() => {
  context.mocks.s3.send.mockResolvedValue({});
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
});

afterEach(() => {
  clearMockedEnv();
});

function telegramClient() {
  return setupApp({ context })(zeroIntegrationsTelegramContract);
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

async function latestRunForFixture(fixture: TelegramPostFixture) {
  const db = store.set(writeDb$);
  const [run] = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, fixture.orgId),
        eq(agentRuns.userId, fixture.userId),
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return run;
}

function mentionEntity(username: string) {
  return { type: "mention", offset: 0, length: username.length + 1 };
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
      store.set(
        seedTelegramPostFixture$,
        { linkTelegramUser: false },
        context.signal,
      ),
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
  it("registers a custom Telegram bot and configures its webhook", async () => {
    const telegramBotId = newTelegramBotId();
    const fixture = await trackFixture(
      store.set(
        seedTelegramPostFixture$,
        { telegramBotId, installBot: false },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockEnv("VM0_API_URL", "https://api.example.test");
    mockEnv("VM0_WEB_URL", "https://app.example.test");
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
      `https://app.example.test/api/telegram/webhook/${telegramBotId}`,
      expect.stringMatching(/^[0-9a-f]{64}$/u),
    );
    expect(context.mocks.telegram.setMyCommands).toHaveBeenCalledWith(
      TEST_BOT_TOKEN,
      expect.arrayContaining([expect.objectContaining({ command: "connect" })]),
    );

    const db = store.set(writeDb$);
    const [installation] = await db
      .select()
      .from(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, telegramBotId))
      .limit(1);
    expect(installation?.defaultComposeId).toBe(fixture.composeId);
    expect(installation?.botUsername).toBe("registered_bot");
  });

  it("rolls back a new installation when webhook registration fails", async () => {
    const telegramBotId = newTelegramBotId();
    const fixture = await trackFixture(
      store.set(
        seedTelegramPostFixture$,
        { telegramBotId, installBot: false },
        context.signal,
      ),
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
    const db = store.set(writeDb$);
    const rows = await db
      .select()
      .from(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, telegramBotId));
    expect(rows).toHaveLength(0);
  });
});

describe("POST /api/telegram/webhook/:telegramBotId", () => {
  it("validates bot ownership, webhook secret, and JSON payload", async () => {
    const fixture = await trackFixture(
      store.set(seedTelegramPostFixture$, {}, context.signal),
    );

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
      store.set(
        seedTelegramPostFixture$,
        { linkTelegramUser: true },
        context.signal,
      ),
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
    await clearAllDetached();

    const run = await latestRunForFixture(fixture);
    expect(run).toMatchObject({ status: "pending", error: null });
    expect(run?.prompt).toBe("hello from telegram");
    expect(run?.appendSystemPrompt).toContain("Telegram username: @alice");
    expect(run?.appendSystemPrompt).toContain("Bot ID:");
    expect(telegramMocks.chatActions).toHaveLength(1);

    const db = store.set(writeDb$);
    const [zeroRun] = await db
      .select()
      .from(zeroRuns)
      .where(eq(zeroRuns.id, run!.id))
      .limit(1);
    expect(zeroRun?.triggerSource).toBe("telegram");
    const [callback] = await db
      .select()
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, run!.id))
      .limit(1);
    expect(callback?.url).toBe(
      "http://localhost:3000/api/internal/callbacks/telegram",
    );
    const [job] = await db
      .select()
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, run!.id))
      .limit(1);
    expect(job).toBeDefined();
  });

  it("stores non-addressed group messages without creating a run", async () => {
    const fixture = await trackFixture(
      store.set(seedTelegramPostFixture$, {}, context.signal),
    );

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
    await clearAllDetached();

    const db = store.set(writeDb$);
    const runs = await db
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, fixture.orgId),
          eq(agentRuns.userId, fixture.userId),
        ),
      );
    expect(runs).toHaveLength(0);
    const messages = await db
      .select()
      .from(telegramMessages)
      .where(eq(telegramMessages.installationId, fixture.telegramBotId));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe("ambient group chatter");
  });

  it("creates a Zero run for a linked custom-bot group mention", async () => {
    const fixture = await trackFixture(
      store.set(
        seedTelegramPostFixture$,
        { linkTelegramUser: true },
        context.signal,
      ),
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
    await clearAllDetached();

    const run = await latestRunForFixture(fixture);
    expect(run?.prompt).toBe("summarize this thread");
    expect(run?.appendSystemPrompt).toContain("Chat type: group");
  });

  it("creates a Zero run for a linked official-bot private message", async () => {
    configureOfficialBotEnv();
    const fixture = await trackFixture(
      store.set(
        seedTelegramPostFixture$,
        { installBot: false, seedOfficialLink: true },
        context.signal,
      ),
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
    await clearAllDetached();

    const run = await latestRunForFixture(fixture);
    expect(run?.prompt).toBe("run through official bot");
    expect(run?.appendSystemPrompt).toContain(
      "Bot username: @official_zero_bot",
    );
    const db = store.set(writeDb$);
    const [zeroRun] = await db
      .select()
      .from(zeroRuns)
      .where(eq(zeroRuns.id, run!.id))
      .limit(1);
    expect(zeroRun?.triggerSource).toBe("telegram");
  });

  it("creates a Zero run for a linked official-bot group mention", async () => {
    configureOfficialBotEnv();
    const fixture = await trackFixture(
      store.set(
        seedTelegramPostFixture$,
        { installBot: false, seedOfficialLink: true },
        context.signal,
      ),
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
    await clearAllDetached();

    const run = await latestRunForFixture(fixture);
    expect(run?.prompt).toBe("help from a group");
    expect(run?.appendSystemPrompt).toContain(
      "Bot username: @official_zero_bot",
    );
  });

  it("routes custom-bot commands by username target", async () => {
    const fixture = await trackFixture(
      store.set(seedTelegramPostFixture$, {}, context.signal),
    );
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
    await clearAllDetached();
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
    await clearAllDetached();
    expect(telegramMocks.sentMessages).toHaveLength(1);
    expect(telegramMocks.sentMessages[0]?.text).toContain(
      "please connect your account first",
    );
    expect(
      telegramMocks.sentMessages[0]?.reply_markup?.inline_keyboard[0]?.[0]?.url,
    ).toBe(`https://t.me/${botUsername}?start=connect`);
  });

  it("handles custom-bot disconnect command", async () => {
    const fixture = await trackFixture(
      store.set(
        seedTelegramPostFixture$,
        { linkTelegramUser: true },
        context.signal,
      ),
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
    await clearAllDetached();

    const db = store.set(writeDb$);
    const links = await db
      .select()
      .from(telegramUserLinks)
      .where(eq(telegramUserLinks.installationId, fixture.telegramBotId));
    expect(links).toHaveLength(0);
    expect(telegramMocks.sentMessages[0]?.text).toContain(
      "You have been disconnected",
    );
  });
});
