import { randomUUID } from "node:crypto";

import {
  OFFICIAL_TELEGRAM_BOT_ID,
  zeroIntegrationsTelegramContract,
} from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import {
  agentComposeVersions,
  agentComposes,
} from "@vm0/db/schema/agent-compose";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramMessages } from "@vm0/db/schema/telegram-message";
import { telegramOfficialUserLinks } from "@vm0/db/schema/telegram-official-user-link";
import { telegramThreadSessions } from "@vm0/db/schema/telegram-thread-session";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { command, createStore } from "ccstate";
import { and, desc, eq, inArray } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockedEnv, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { nowDate } from "../../external/time";
import { decryptSecretValue } from "../../services/crypto.utils";
import { clearAllDetached } from "../../utils";
import { seedAgentRunCallback$ } from "./helpers/agent-run-callback";
import { encryptSecretForTests } from "./helpers/encrypt-secret";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const TEST_BOT_TOKEN = "123456:test-bot-token";
const NEW_BOT_TOKEN = "123456:new-test-bot-token";
const OFFICIAL_BOT_TOKEN = "987654:official-bot-token";
const OFFICIAL_BOT_USERNAME = "official_zero_bot";
const OFFICIAL_WEBHOOK_SECRET = "official-webhook-secret";
const CALLBACK_SECRET = "test-callback-secret";

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
        .values({ orgId, defaultAgentId: composeId, credits: 100_000 })
        .onConflictDoUpdate({
          target: orgMetadata.orgId,
          set: { defaultAgentId: composeId, credits: 100_000 },
        });
      signal.throwIfAborted();
    }
    await db.insert(vm0ApiKeys).values([
      {
        vendor: "anthropic",
        model: "claude-sonnet-4-6",
        apiKey: `vm0-key-anthropic-${composeId}`,
        label: composeId,
      },
      {
        vendor: "deepseek",
        model: "deepseek-v4-pro",
        apiKey: `vm0-key-deepseek-${composeId}`,
        label: composeId,
      },
    ]);
    signal.throwIfAborted();

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
      versionId,
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
    .delete(orgModelPolicies)
    .where(eq(orgModelPolicies.orgId, fixture.orgId));
  await db
    .delete(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, fixture.orgId),
        eq(orgMembersMetadata.userId, fixture.userId),
      ),
    );
  await db.delete(vm0ApiKeys).where(eq(vm0ApiKeys.label, fixture.composeId));
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

function callbackHeaders(rawBody: string) {
  const timestamp = Math.floor(nowDate().getTime() / 1000);
  return {
    "content-type": "application/json",
    "X-VM0-Timestamp": String(timestamp),
    "X-VM0-Signature": computeHmacSignature(
      rawBody,
      CALLBACK_SECRET,
      timestamp,
    ),
  };
}

async function postTelegramCallback(body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  return await createApp({ signal: context.signal }).request(
    "/api/internal/callbacks/telegram",
    {
      method: "POST",
      headers: callbackHeaders(rawBody),
      body: rawBody,
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

async function runForFixturePrompt(
  fixture: TelegramPostFixture,
  prompt: string,
) {
  const db = store.set(writeDb$);
  const [run] = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, fixture.orgId),
        eq(agentRuns.userId, fixture.userId),
        eq(agentRuns.prompt, prompt),
      ),
    )
    .limit(1);
  return run;
}

async function latestZeroRunForFixture(fixture: TelegramPostFixture) {
  const db = store.set(writeDb$);
  const [run] = await db
    .select({
      id: zeroRuns.id,
      modelProvider: zeroRuns.modelProvider,
      selectedModel: zeroRuns.selectedModel,
    })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
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

async function linkedTelegramUserLinkId(
  fixture: TelegramPostFixture,
): Promise<string> {
  const db = store.set(writeDb$);
  const [link] = await db
    .select({ id: telegramUserLinks.id })
    .from(telegramUserLinks)
    .where(
      and(
        eq(telegramUserLinks.installationId, fixture.telegramBotId),
        eq(telegramUserLinks.vm0UserId, fixture.userId),
      ),
    )
    .limit(1);
  if (!link) {
    throw new Error("Expected seeded Telegram user link");
  }
  return link.id;
}

async function officialTelegramUserLinkId(
  fixture: TelegramPostFixture,
): Promise<string> {
  const db = store.set(writeDb$);
  const [link] = await db
    .select({ id: telegramOfficialUserLinks.id })
    .from(telegramOfficialUserLinks)
    .where(
      and(
        eq(telegramOfficialUserLinks.orgId, fixture.orgId),
        eq(telegramOfficialUserLinks.vm0UserId, fixture.userId),
      ),
    )
    .limit(1);
  if (!link) {
    throw new Error("Expected seeded official Telegram user link");
  }
  return link.id;
}

async function seedAgentSession(fixture: TelegramPostFixture): Promise<string> {
  const db = store.set(writeDb$);
  const [session] = await db
    .insert(agentSessions)
    .values({
      userId: fixture.userId,
      orgId: fixture.orgId,
      agentComposeId: fixture.composeId,
    })
    .returning({ id: agentSessions.id });
  if (!session) {
    throw new Error("Failed to seed Telegram agent session");
  }
  return session.id;
}

async function seedTelegramThreadSession(args: {
  readonly telegramUserLinkId?: string;
  readonly telegramOfficialUserLinkId?: string;
  readonly chatId: string;
  readonly rootMessageId: string;
  readonly agentSessionId: string;
}): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(telegramThreadSessions).values({
    telegramUserLinkId: args.telegramUserLinkId,
    telegramOfficialUserLinkId: args.telegramOfficialUserLinkId,
    chatId: args.chatId,
    rootMessageId: args.rootMessageId,
    agentSessionId: args.agentSessionId,
  });
}

async function hasTelegramThreadSession(args: {
  readonly telegramUserLinkId: string;
  readonly chatId: string;
  readonly rootMessageId: string;
}): Promise<boolean> {
  const db = store.set(writeDb$);
  const [thread] = await db
    .select({ id: telegramThreadSessions.id })
    .from(telegramThreadSessions)
    .where(
      and(
        eq(telegramThreadSessions.telegramUserLinkId, args.telegramUserLinkId),
        eq(telegramThreadSessions.chatId, args.chatId),
        eq(telegramThreadSessions.rootMessageId, args.rootMessageId),
      ),
    )
    .limit(1);
  return thread !== undefined;
}

async function seedRunningRun(fixture: TelegramPostFixture): Promise<void> {
  const db = store.set(writeDb$);
  const sessionId = await seedAgentSession(fixture);
  const startedAt = nowDate();
  await db.insert(agentRuns).values({
    userId: fixture.userId,
    orgId: fixture.orgId,
    agentComposeVersionId: fixture.versionId,
    sessionId,
    status: "running",
    prompt: "existing running telegram run",
    startedAt,
    lastHeartbeatAt: startedAt,
  });
}

async function seedCompletedRun(args: {
  readonly fixture: TelegramPostFixture;
  readonly modelProvider?: string | null;
  readonly selectedModel: string;
}): Promise<string> {
  const db = store.set(writeDb$);
  const sessionId = await seedAgentSession(args.fixture);
  const [run] = await db
    .insert(agentRuns)
    .values({
      userId: args.fixture.userId,
      orgId: args.fixture.orgId,
      agentComposeVersionId: args.fixture.versionId,
      sessionId,
      status: "completed",
      prompt: "previous telegram session",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      completedAt: new Date("2026-01-01T00:01:00.000Z"),
    })
    .returning({ id: agentRuns.id });
  if (!run) {
    throw new Error("Failed to seed previous Telegram run");
  }
  await db.insert(zeroRuns).values({
    id: run.id,
    triggerSource: "telegram",
    modelProvider: args.modelProvider ?? null,
    selectedModel: args.selectedModel,
  });
  return sessionId;
}

async function seedModelPolicies(args: {
  readonly fixture: TelegramPostFixture;
  readonly selectedModel?: string | null;
}): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(orgModelPolicies).values([
    {
      orgId: args.fixture.orgId,
      model: "claude-sonnet-4-6",
      isDefault: true,
      defaultProviderType: "vm0",
      credentialScope: "org",
      createdByUserId: args.fixture.userId,
      updatedByUserId: args.fixture.userId,
    },
    {
      orgId: args.fixture.orgId,
      model: "claude-opus-4-7",
      defaultProviderType: "vm0",
      credentialScope: "org",
      createdByUserId: args.fixture.userId,
      updatedByUserId: args.fixture.userId,
    },
    {
      orgId: args.fixture.orgId,
      model: "deepseek-v4-pro",
      defaultProviderType: "vm0",
      credentialScope: "org",
      createdByUserId: args.fixture.userId,
      updatedByUserId: args.fixture.userId,
    },
  ]);
  await db.insert(vm0ApiKeys).values([
    {
      vendor: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "vm0-key-claude-sonnet-4-6",
      label: args.fixture.composeId,
    },
    {
      vendor: "anthropic",
      model: "claude-opus-4-7",
      apiKey: "vm0-key-claude-opus-4-7",
      label: args.fixture.composeId,
    },
  ]);
  await db
    .insert(orgMembersMetadata)
    .values({
      orgId: args.fixture.orgId,
      userId: args.fixture.userId,
      selectedModel: args.selectedModel ?? null,
    })
    .onConflictDoUpdate({
      target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      set: { selectedModel: args.selectedModel ?? null },
    });
}

async function seedOrgCredits(
  fixture: TelegramPostFixture,
  credits: number,
): Promise<void> {
  await store
    .set(writeDb$)
    .update(orgMetadata)
    .set({ credits })
    .where(eq(orgMetadata.orgId, fixture.orgId));
}

async function selectedModelFor(
  fixture: TelegramPostFixture,
): Promise<string | null> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({ selectedModel: orgMembersMetadata.selectedModel })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, fixture.orgId),
        eq(orgMembersMetadata.userId, fixture.userId),
      ),
    )
    .limit(1);
  return row?.selectedModel ?? null;
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
      store.set(
        seedTelegramPostFixture$,
        { telegramBotId, installBot: false },
        context.signal,
      ),
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

    const db = store.set(writeDb$);
    const [installation] = await db
      .select()
      .from(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, telegramBotId))
      .limit(1);
    expect(installation?.defaultComposeId).toBe(fixture.composeId);
    expect(installation?.botUsername).toBe("registered_bot");
  });

  it("uses the active org default agent when defaultAgentId is omitted", async () => {
    const telegramBotId = newTelegramBotId();
    const fixture = await trackFixture(
      store.set(
        seedTelegramPostFixture$,
        { telegramBotId, installBot: false },
        context.signal,
      ),
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
    const fixture = await trackFixture(
      store.set(seedTelegramPostFixture$, {}, context.signal),
    );
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
    const fixture = await trackFixture(
      store.set(seedTelegramPostFixture$, {}, context.signal),
    );
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

    const db = store.set(writeDb$);
    const [installation] = await db
      .select()
      .from(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, fixture.telegramBotId))
      .limit(1);
    expect(installation).toBeDefined();
    if (!installation) {
      throw new Error("Expected Telegram installation to exist");
    }
    expect(decryptSecretValue(installation.encryptedBotToken)).toBe(
      NEW_BOT_TOKEN,
    );
  });

  it("rejects reinstall when the token belongs to a different bot", async () => {
    const fixture = await trackFixture(
      store.set(seedTelegramPostFixture$, {}, context.signal),
    );
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
      store.set(
        seedTelegramPostFixture$,
        { telegramBotId, installBot: false, seedDefaultAgent: false },
        context.signal,
      ),
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
      store.set(
        seedTelegramPostFixture$,
        {
          orgId: `org_other_${randomUUID().slice(0, 8)}`,
          userId: `user_other_${randomUUID().slice(0, 8)}`,
          installBot: false,
        },
        context.signal,
      ),
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
    expect(telegramMocks.sentMessages).toHaveLength(0);

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

  it("formats generic failed callback errors for Telegram replies", async () => {
    const fixture = await trackFixture(
      store.set(
        seedTelegramPostFixture$,
        { linkTelegramUser: true },
        context.signal,
      ),
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
    await clearAllDetached();

    const run = await latestRunForFixture(fixture);
    expect(run?.id).toBeDefined();
    const { callbackId } = await store.set(
      seedAgentRunCallback$,
      {
        runId: run!.id,
        url: "http://localhost:3000/api/internal/callbacks/telegram",
        payload: {
          installationId: fixture.telegramBotId,
          chatId: "77002",
          messageId: "43",
          rootMessageId: null,
          userLinkId: await linkedTelegramUserLinkId(fixture),
          agentId: fixture.composeId,
          existingSessionId: null,
          isDM: true,
        },
      },
      context.signal,
    );

    const response = await postTelegramCallback({
      callbackId,
      runId: run!.id,
      status: "failed",
      error: "thread/resume failed: rollout is empty",
      payload: {
        installationId: fixture.telegramBotId,
        chatId: "77002",
        messageId: "43",
        rootMessageId: null,
        userLinkId: await linkedTelegramUserLinkId(fixture),
        agentId: fixture.composeId,
        existingSessionId: null,
        isDM: true,
      },
    });

    expect(response.status).toBe(200);
    await clearAllDetached();
    expect(telegramMocks.sentMessages.at(-1)?.text).toContain(
      "Oops, something went wrong. Please try again later.",
    );
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

  it("stores custom-bot group replies to another bot without sending a prompt", async () => {
    const fixture = await trackFixture(
      store.set(seedTelegramPostFixture$, {}, context.signal),
    );
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
    await clearAllDetached();
    expect(telegramMocks.sentMessages).toHaveLength(0);

    const db = store.set(writeDb$);
    const messages = await db
      .select()
      .from(telegramMessages)
      .where(eq(telegramMessages.installationId, fixture.telegramBotId));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe("following up");
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

  it("handles custom-bot connect and help command copy", async () => {
    const fixture = await trackFixture(
      store.set(
        seedTelegramPostFixture$,
        { linkTelegramUser: true },
        context.signal,
      ),
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
    await clearAllDetached();
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
    await clearAllDetached();
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
    await clearAllDetached();
    expect(telegramMocks.sentMessages[2]?.text).toContain(
      "Telegram Agent Telegram Bot Help",
    );
    expect(telegramMocks.sentMessages[2]?.text).toContain("/new_session");
    expect(telegramMocks.sentMessages[2]?.text).not.toContain("admin");
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

  it("completes a pending custom-bot link on the first private message", async () => {
    const fixture = await trackFixture(
      store.set(seedTelegramPostFixture$, {}, context.signal),
    );
    const db = store.set(writeDb$);
    await db.insert(telegramUserLinks).values({
      installationId: fixture.telegramBotId,
      telegramUserId: "pending",
      telegramUsername: null,
      telegramDisplayName: null,
      vm0UserId: fixture.userId,
    });
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
    await clearAllDetached();

    const links = await db
      .select({
        telegramUserId: telegramUserLinks.telegramUserId,
        telegramUsername: telegramUserLinks.telegramUsername,
      })
      .from(telegramUserLinks)
      .where(eq(telegramUserLinks.installationId, fixture.telegramBotId));
    expect(links).toStrictEqual([
      { telegramUserId: "78901", telegramUsername: "admin_user" },
    ]);
  });

  it("clears a custom-bot private thread with /new_session and ignores the command in groups", async () => {
    const fixture = await trackFixture(
      store.set(
        seedTelegramPostFixture$,
        { linkTelegramUser: true },
        context.signal,
      ),
    );
    const userLinkId = await linkedTelegramUserLinkId(fixture);
    const sessionId = await seedAgentSession(fixture);
    await seedTelegramThreadSession({
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
    await clearAllDetached();
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
    await clearAllDetached();
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
      store.set(
        seedTelegramPostFixture$,
        { linkTelegramUser: true },
        context.signal,
      ),
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
    await clearAllDetached();
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
    await clearAllDetached();
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
    await clearAllDetached();
    expect(telegramMocks.sentMessages[2]?.text).toContain(
      "Unknown model &quot;default&quot;.",
    );
    await expect(selectedModelFor(fixture)).resolves.toBe("claude-sonnet-4-6");
  });

  it("sends typing for accepted custom-bot runs and a queued message at the concurrency limit", async () => {
    const acceptedFixture = await trackFixture(
      store.set(
        seedTelegramPostFixture$,
        { linkTelegramUser: true },
        context.signal,
      ),
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
    await clearAllDetached();
    expect(acceptedTelegramMocks.chatActions).toHaveLength(1);
    expect(acceptedTelegramMocks.sentMessages).toHaveLength(0);

    const queuedFixture = await trackFixture(
      store.set(
        seedTelegramPostFixture$,
        { linkTelegramUser: true },
        context.signal,
      ),
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
    await clearAllDetached();
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
    await clearAllDetached();
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
    await clearAllDetached();
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
      store.set(
        seedTelegramPostFixture$,
        {
          installBot: false,
          seedOfficialLink: true,
        },
        context.signal,
      ),
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
    await clearAllDetached();
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
      store.set(
        seedTelegramPostFixture$,
        { linkTelegramUser: true },
        context.signal,
      ),
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
    await clearAllDetached();
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
      store.set(
        seedTelegramPostFixture$,
        { linkTelegramUser: true },
        context.signal,
      ),
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
    await clearAllDetached();
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
