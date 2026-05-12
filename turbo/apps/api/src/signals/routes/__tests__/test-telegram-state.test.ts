import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { e2eTelegramMockCallLog } from "@vm0/db/schema/e2e-telegram-mock-call-log";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramMessages } from "@vm0/db/schema/telegram-message";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { createFixtureTracker } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();

interface SeededTelegramState {
  readonly botId: string;
  readonly orgId: string;
  readonly composeId: string;
  readonly versionId: string;
  readonly chatId: string;
}

interface TelegramStateResponse {
  readonly installation: Record<string, unknown> | null;
  readonly links: readonly Record<string, unknown>[];
  readonly message_count: number;
  readonly recent_runs: readonly Record<string, unknown>[];
  readonly org_metadata: Record<string, unknown> | null;
  readonly default_agent: Record<string, unknown> | null;
  readonly default_compose: Record<string, unknown> | null;
  readonly default_compose_version: {
    readonly id: string;
    readonly content_keys: readonly string[];
  } | null;
  readonly resolved_telegram_api_url: string | null;
  readonly mock_calls: readonly Record<string, unknown>[];
}

function requestApp(path: string, init?: RequestInit): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return Promise.resolve(app.request(path, init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function seedTelegramState(): Promise<SeededTelegramState> {
  const writeDb = store.set(writeDb$);
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const botId = `bot_${randomUUID()}`;
  const composeId = randomUUID();
  const versionId = randomUUID().replaceAll("-", "");
  const chatId = `chat_${randomUUID()}`;

  await writeDb.insert(agentComposes).values({
    id: composeId,
    userId,
    name: "telegram-state-agent",
    orgId,
    headVersionId: versionId,
  });
  await writeDb.insert(agentComposeVersions).values({
    id: versionId,
    composeId,
    content: { model: "gpt-5.4", instructions: "Reply concisely" },
    createdBy: userId,
  });
  await writeDb.insert(zeroAgents).values({
    id: composeId,
    orgId,
    owner: userId,
    name: "telegram-state-agent",
  });
  await writeDb.insert(orgMetadata).values({
    orgId,
    defaultAgentId: composeId,
    tier: "free",
  });
  await writeDb.insert(telegramInstallations).values({
    telegramBotId: botId,
    botUsername: "vm0_test_bot",
    encryptedBotToken: "encrypted-token",
    webhookSecret: "webhook-secret",
    defaultComposeId: composeId,
    ownerUserId: userId,
    orgId,
  });
  await writeDb.insert(telegramUserLinks).values({
    installationId: botId,
    telegramUserId: "telegram-user-1",
    vm0UserId: userId,
    dmWelcomeSent: true,
  });
  await writeDb.insert(telegramMessages).values({
    installationId: botId,
    chatId,
    messageId: "message-1",
    fromUserId: "telegram-user-1",
    text: "hello from telegram",
  });
  await writeDb.insert(e2eTelegramMockCallLog).values({
    method: "sendMessage",
    botToken: "test-bot-token",
    chatId,
    body: "{}",
    bodyJson: { ok: true },
  });

  return { botId, orgId, composeId, versionId, chatId };
}

async function cleanupTelegramState(state: SeededTelegramState): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .delete(e2eTelegramMockCallLog)
    .where(eq(e2eTelegramMockCallLog.chatId, state.chatId));
  await writeDb
    .delete(telegramMessages)
    .where(eq(telegramMessages.installationId, state.botId));
  await writeDb
    .delete(telegramUserLinks)
    .where(eq(telegramUserLinks.installationId, state.botId));
  await writeDb
    .delete(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, state.botId));
  await writeDb.delete(orgMetadata).where(eq(orgMetadata.orgId, state.orgId));
  await writeDb.delete(zeroAgents).where(eq(zeroAgents.id, state.composeId));
  await writeDb
    .delete(agentComposeVersions)
    .where(eq(agentComposeVersions.id, state.versionId));
  await writeDb
    .delete(agentComposes)
    .where(eq(agentComposes.id, state.composeId));
}

const trackTelegramState = createFixtureTracker(cleanupTelegramState);

describe("GET /api/test/telegram-state", () => {
  it("returns 404 when the test endpoint is not allowed", async () => {
    mockEnv("ENV", "production");

    const response = await requestApp("/api/test/telegram-state?bot_id=bot-1");

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("returns 400 when bot_id is missing", async () => {
    mockEnv("ENV", "development");

    const response = await requestApp("/api/test/telegram-state");

    expect(response.status).toBe(400);
    await expect(readJson<{ error: string }>(response)).resolves.toStrictEqual({
      error: "bot_id query param is required",
    });
  });

  it("returns empty diagnostic state for an unknown bot", async () => {
    mockEnv("ENV", "development");

    const response = await requestApp(
      `/api/test/telegram-state?bot_id=bot_${randomUUID()}`,
    );

    expect(response.status).toBe(200);
    const body = await readJson<TelegramStateResponse>(response);
    expect(body.installation).toBeNull();
    expect(body.links).toStrictEqual([]);
    expect(body.message_count).toBe(0);
    expect(body.recent_runs).toStrictEqual([]);
    expect(body.org_metadata).toBeNull();
    expect(body.default_agent).toBeNull();
    expect(body.default_compose).toBeNull();
    expect(body.default_compose_version).toBeNull();
    expect(body.resolved_telegram_api_url).toBeNull();
    expect(Array.isArray(body.mock_calls)).toBeTruthy();
  });

  it("returns seeded Telegram diagnostic state", async () => {
    mockEnv("ENV", "development");
    mockOptionalEnv("TELEGRAM_API_URL", "https://telegram.test/bot");
    const seeded = await trackTelegramState(seedTelegramState());

    const response = await requestApp(
      `/api/test/telegram-state?bot_id=${seeded.botId}`,
    );

    expect(response.status).toBe(200);
    const body = await readJson<TelegramStateResponse>(response);
    expect(body.installation).toMatchObject({
      telegramBotId: seeded.botId,
      orgId: seeded.orgId,
      defaultComposeId: seeded.composeId,
    });
    expect(body.links).toHaveLength(1);
    expect(body.links[0]).toMatchObject({
      telegramUserId: "telegram-user-1",
      dmWelcomeSent: true,
    });
    expect(body.message_count).toBe(1);
    expect(body.org_metadata).toMatchObject({
      orgId: seeded.orgId,
      defaultAgentId: seeded.composeId,
      tier: "free",
    });
    expect(body.default_agent).toMatchObject({
      id: seeded.composeId,
      name: "telegram-state-agent",
      orgId: seeded.orgId,
    });
    expect(body.default_compose).toMatchObject({
      id: seeded.composeId,
      name: "telegram-state-agent",
      headVersionId: seeded.versionId,
    });
    expect(body.default_compose_version).toStrictEqual({
      id: seeded.versionId,
      content_keys: ["model", "instructions"],
    });
    expect(body.resolved_telegram_api_url).toBe("https://telegram.test/bot");
    expect(
      body.mock_calls.some((call) => {
        return call.chatId === seeded.chatId && call.method === "sendMessage";
      }),
    ).toBeTruthy();
  });
});
