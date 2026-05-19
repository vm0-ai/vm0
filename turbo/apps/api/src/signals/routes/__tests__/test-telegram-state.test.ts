import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { count, eq, inArray } from "drizzle-orm";

import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { e2eTelegramMockCallLog } from "@vm0/db/schema/e2e-telegram-mock-call-log";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramMessages } from "@vm0/db/schema/telegram-message";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { createFixtureTracker } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();

interface SeededTelegramState {
  readonly botId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly composeId: string;
  readonly versionId: string;
  readonly chatId: string;
}

interface SeededTelegramPostState {
  readonly botId: string;
  readonly orgId: string;
  readonly composeId: string;
}

interface SeededSlackPostState {
  readonly teamId: string;
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

interface TelegramStateSeedResponse {
  readonly ok: true;
  readonly bot_id: string;
  readonly org_id: string;
  readonly vm0_user_id: string;
  readonly user_link_id: string | null;
  readonly default_agent_id: string;
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

  return { botId, userId, orgId, composeId, versionId, chatId };
}

async function cleanupTelegramState(state: SeededTelegramState): Promise<void> {
  const writeDb = store.set(writeDb$);
  const runRows = await writeDb
    .select({ id: agentRuns.id, sessionId: agentRuns.sessionId })
    .from(agentRuns)
    .where(eq(agentRuns.orgId, state.orgId));
  const runIds = runRows.map((run) => {
    return run.id;
  });
  if (runIds.length > 0) {
    await writeDb.delete(zeroRuns).where(inArray(zeroRuns.id, runIds));
    await writeDb.delete(agentRuns).where(inArray(agentRuns.id, runIds));
  }
  const sessionIds = runRows.map((run) => {
    return run.sessionId;
  });
  if (sessionIds.length > 0) {
    await writeDb
      .delete(agentSessions)
      .where(inArray(agentSessions.id, sessionIds));
  }
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

async function cleanupTelegramPostState(
  state: SeededTelegramPostState,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .delete(telegramMessages)
    .where(eq(telegramMessages.installationId, state.botId));
  await writeDb
    .delete(telegramUserLinks)
    .where(eq(telegramUserLinks.installationId, state.botId));
  await writeDb
    .delete(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, state.botId));
  await writeDb
    .delete(creditExpiresRecord)
    .where(eq(creditExpiresRecord.orgId, state.orgId));
  await writeDb.delete(orgMetadata).where(eq(orgMetadata.orgId, state.orgId));
  await writeDb.delete(zeroAgents).where(eq(zeroAgents.id, state.composeId));
  await writeDb
    .delete(agentComposeVersions)
    .where(eq(agentComposeVersions.composeId, state.composeId));
  await writeDb
    .delete(agentComposes)
    .where(eq(agentComposes.id, state.composeId));
}

async function cleanupSlackPostState(
  state: SeededSlackPostState,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .delete(slackOrgConnections)
    .where(eq(slackOrgConnections.slackWorkspaceId, state.teamId));
  await writeDb
    .delete(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, state.teamId));
}

const trackTelegramState = createFixtureTracker(cleanupTelegramState);
const trackTelegramPostState = createFixtureTracker(cleanupTelegramPostState);
const trackSlackPostState = createFixtureTracker(cleanupSlackPostState);

function mockClerkTestUser(args: {
  readonly userId: string;
  readonly orgId: string;
}): void {
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [{ id: args.userId }],
  });
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [
      {
        createdAt: 2,
        organization: { id: `org_ignored_${randomUUID()}` },
      },
      {
        createdAt: 1,
        organization: { id: args.orgId },
      },
    ],
  });
}

function postTelegramState(body: Record<string, unknown>): Promise<Response> {
  return requestApp("/api/test/telegram-state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function postSlackState(body: Record<string, unknown>): Promise<Response> {
  return requestApp("/api/test/slack-state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedRun(
  state: SeededTelegramState,
  triggerSource: "slack" | "telegram",
): Promise<string> {
  const writeDb = store.set(writeDb$);
  const sessionId = randomUUID();
  const runId = randomUUID();
  await writeDb.insert(agentSessions).values({
    id: sessionId,
    userId: state.userId,
    orgId: state.orgId,
    agentComposeId: state.composeId,
  });
  await writeDb.insert(agentRuns).values({
    id: runId,
    userId: state.userId,
    orgId: state.orgId,
    sessionId,
    status: "completed",
    prompt: `${triggerSource} diagnostic run`,
  });
  await writeDb.insert(zeroRuns).values({
    id: runId,
    triggerSource,
  });
  return runId;
}

async function countInstallations(botId: string): Promise<number> {
  const writeDb = store.set(writeDb$);
  const [row] = await writeDb
    .select({ value: count() })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, botId));
  return row?.value ?? 0;
}

async function countLinks(botId: string): Promise<number> {
  const writeDb = store.set(writeDb$);
  const [row] = await writeDb
    .select({ value: count() })
    .from(telegramUserLinks)
    .where(eq(telegramUserLinks.installationId, botId));
  return row?.value ?? 0;
}

async function countMessages(botId: string): Promise<number> {
  const writeDb = store.set(writeDb$);
  const [row] = await writeDb
    .select({ value: count() })
    .from(telegramMessages)
    .where(eq(telegramMessages.installationId, botId));
  return row?.value ?? 0;
}

async function countAgentRuns(runId: string): Promise<number> {
  const writeDb = store.set(writeDb$);
  const [row] = await writeDb
    .select({ value: count() })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));
  return row?.value ?? 0;
}

async function countZeroRuns(runId: string): Promise<number> {
  const writeDb = store.set(writeDb$);
  const [row] = await writeDb
    .select({ value: count() })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId));
  return row?.value ?? 0;
}

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

describe("POST /api/test/telegram-state", () => {
  beforeEach(() => {
    context.mocks.clerk.users.getUserList.mockReset();
    context.mocks.clerk.users.getOrganizationMembershipList.mockReset();
  });

  it("returns 404 when the test endpoint is not allowed", async () => {
    mockEnv("ENV", "production");

    const response = await postTelegramState({
      bot_id: "bot-disabled",
      telegram_user_id: "telegram-user",
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("returns 400 when required seed fields are missing", async () => {
    mockEnv("ENV", "development");

    const response = await postTelegramState({ bot_id: "bot-missing-user" });

    expect(response.status).toBe(400);
    await expect(readJson<{ error: string }>(response)).resolves.toStrictEqual({
      error: "bot_id and telegram_user_id are required",
    });
  });

  it("seeds a Telegram installation, user link, and shared default agent", async () => {
    mockEnv("ENV", "development");
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const botId = `bot_${randomUUID()}`;
    const telegramUserId = `telegram_${randomUUID()}`;
    const email = `${randomUUID()}@example.test`;
    mockClerkTestUser({ userId, orgId });

    const response = await postTelegramState({
      bot_id: botId,
      telegram_user_id: telegramUserId,
      bot_username: "custom_test_bot",
      webhook_secret: "custom-webhook-secret",
      email,
    });

    expect(response.status).toBe(200);
    const body = await readJson<TelegramStateSeedResponse>(response);
    await trackTelegramPostState(
      Promise.resolve({ botId, orgId, composeId: body.default_agent_id }),
    );
    expect(body).toMatchObject({
      ok: true,
      bot_id: botId,
      org_id: orgId,
      vm0_user_id: userId,
      default_agent_id: expect.any(String),
    });
    expect(body.user_link_id).toStrictEqual(expect.any(String));
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
      emailAddress: [email],
    });

    const writeDb = store.set(writeDb$);
    const [installation] = await writeDb
      .select()
      .from(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, botId))
      .limit(1);
    expect(installation).toMatchObject({
      telegramBotId: botId,
      botUsername: "custom_test_bot",
      webhookSecret: "custom-webhook-secret",
      defaultComposeId: body.default_agent_id,
      ownerUserId: userId,
      orgId,
    });
    expect(installation?.encryptedBotToken).toContain(":");

    const links = await writeDb
      .select()
      .from(telegramUserLinks)
      .where(eq(telegramUserLinks.installationId, botId));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      id: body.user_link_id,
      telegramUserId,
      vm0UserId: userId,
    });

    const [org] = await writeDb
      .select()
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);
    expect(org).toMatchObject({
      orgId,
      defaultAgentId: body.default_agent_id,
      credits: 10_000,
      tier: "free",
    });

    const getResponse = await requestApp(
      `/api/test/telegram-state?bot_id=${encodeURIComponent(botId)}`,
    );
    expect(getResponse.status).toBe(200);
    const getBody = await readJson<TelegramStateResponse>(getResponse);
    expect(getBody.installation).toMatchObject({
      telegramBotId: botId,
      orgId,
      defaultComposeId: body.default_agent_id,
    });
    expect(getBody.links).toHaveLength(1);
    expect(getBody.default_agent).toMatchObject({
      id: body.default_agent_id,
      name: "e2e-slack-agent",
      orgId,
    });
  });

  it("keeps POST idempotent and skips link creation when requested", async () => {
    mockEnv("ENV", "development");
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const botId = `bot_${randomUUID()}`;
    const telegramUserId = `telegram_${randomUUID()}`;
    mockClerkTestUser({ userId, orgId });

    const first = await postTelegramState({
      bot_id: botId,
      telegram_user_id: telegramUserId,
    });
    expect(first.status).toBe(200);
    const firstBody = await readJson<TelegramStateSeedResponse>(first);
    await trackTelegramPostState(
      Promise.resolve({
        botId,
        orgId,
        composeId: firstBody.default_agent_id,
      }),
    );

    const second = await postTelegramState({
      bot_id: botId,
      telegram_user_id: telegramUserId,
      seed_link: false,
    });
    expect(second.status).toBe(200);
    const secondBody = await readJson<TelegramStateSeedResponse>(second);
    expect(secondBody).toMatchObject({
      bot_id: botId,
      org_id: orgId,
      vm0_user_id: userId,
      user_link_id: null,
      default_agent_id: firstBody.default_agent_id,
    });

    const links = await store
      .set(writeDb$)
      .select()
      .from(telegramUserLinks)
      .where(eq(telegramUserLinks.installationId, botId));
    expect(links).toHaveLength(1);
    expect(links[0]?.id).toBe(firstBody.user_link_id);
  });

  it("reuses the shared default agent when Telegram preflights race", async () => {
    mockEnv("ENV", "development");
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const botId = `bot_${randomUUID()}`;
    const email = `${randomUUID()}@example.test`;
    mockClerkTestUser({ userId, orgId });

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => {
        return postTelegramState({
          bot_id: botId,
          telegram_user_id: "99001",
          email,
          seed_link: true,
        });
      }),
    );

    const bodies = await Promise.all(
      responses.map(async (response) => {
        if (response.status !== 200) {
          throw new Error(
            `Expected 200, got ${response.status}: ${await response.text()}`,
          );
        }
        return readJson<TelegramStateSeedResponse>(response);
      }),
    );
    const defaultAgentIds = bodies.map((body) => {
      return body.default_agent_id;
    });
    const defaultAgentId = defaultAgentIds[0];
    if (!defaultAgentId) {
      throw new Error("Expected seeded default agent id");
    }
    await trackTelegramPostState(
      Promise.resolve({ botId, orgId, composeId: defaultAgentId }),
    );

    expect(new Set(defaultAgentIds).size).toBe(1);
  });

  it("reuses the shared default agent when Slack and Telegram preflights race", async () => {
    mockEnv("ENV", "development");
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const teamId = `T_${randomUUID().replaceAll("-", "")}`;
    const botId = `bot_${randomUUID()}`;
    const email = `${randomUUID()}@example.test`;
    mockClerkTestUser({ userId, orgId });

    const responses = await Promise.all([
      postSlackState({
        team_id: teamId,
        slack_user_id: "U_TELEGRAM_RACE",
        email,
        seed_connection: true,
        seed_default_agent: true,
      }),
      postTelegramState({
        bot_id: botId,
        telegram_user_id: "99001",
        email,
        seed_link: true,
      }),
    ]);

    const bodies = await Promise.all(
      responses.map(async (response) => {
        if (response.status !== 200) {
          throw new Error(
            `Expected 200, got ${response.status}: ${await response.text()}`,
          );
        }
        return (await response.json()) as {
          readonly default_agent_id: string | null;
        };
      }),
    );
    const defaultAgentIds = bodies.map((body) => {
      return body.default_agent_id;
    });
    const defaultAgentId = defaultAgentIds[0];
    if (!defaultAgentId) {
      throw new Error("Expected seeded default agent id");
    }
    await trackSlackPostState(Promise.resolve({ teamId }));
    await trackTelegramPostState(
      Promise.resolve({ botId, orgId, composeId: defaultAgentId }),
    );

    expect(new Set(defaultAgentIds).size).toBe(1);
    expect(defaultAgentIds).not.toContain(null);
  });
});

describe("DELETE /api/test/telegram-state", () => {
  it("returns 404 when the test endpoint is not allowed", async () => {
    mockEnv("ENV", "production");

    const response = await requestApp("/api/test/telegram-state?bot_id=bot-1", {
      method: "DELETE",
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("returns 400 when bot_id is missing", async () => {
    mockEnv("ENV", "development");

    const response = await requestApp("/api/test/telegram-state", {
      method: "DELETE",
    });

    expect(response.status).toBe(400);
    await expect(readJson<{ error: string }>(response)).resolves.toStrictEqual({
      error: "bot_id query param is required",
    });
  });

  it("returns ok for an unknown bot without deleting unrelated state", async () => {
    mockEnv("ENV", "development");
    const seeded = await trackTelegramState(seedTelegramState());

    const response = await requestApp(
      `/api/test/telegram-state?bot_id=missing_${randomUUID()}`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    await expect(readJson<{ ok: true }>(response)).resolves.toStrictEqual({
      ok: true,
    });
    await expect(countInstallations(seeded.botId)).resolves.toBe(1);
    await expect(countLinks(seeded.botId)).resolves.toBe(1);
    await expect(countMessages(seeded.botId)).resolves.toBe(1);
  });

  it("deletes Telegram state and only Telegram-triggered runs for the bot org", async () => {
    mockEnv("ENV", "development");
    const seeded = await trackTelegramState(seedTelegramState());
    const telegramRunId = await seedRun(seeded, "telegram");
    const slackRunId = await seedRun(seeded, "slack");

    const response = await requestApp(
      `/api/test/telegram-state?bot_id=${seeded.botId}`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    await expect(readJson<{ ok: true }>(response)).resolves.toStrictEqual({
      ok: true,
    });
    await expect(countInstallations(seeded.botId)).resolves.toBe(0);
    await expect(countLinks(seeded.botId)).resolves.toBe(0);
    await expect(countMessages(seeded.botId)).resolves.toBe(0);
    await expect(countZeroRuns(telegramRunId)).resolves.toBe(0);
    await expect(countAgentRuns(telegramRunId)).resolves.toBe(0);
    await expect(countZeroRuns(slackRunId)).resolves.toBe(1);
    await expect(countAgentRuns(slackRunId)).resolves.toBe(1);
  });
});
