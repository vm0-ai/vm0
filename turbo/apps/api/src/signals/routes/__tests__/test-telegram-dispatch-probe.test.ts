import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { and, desc, eq, inArray } from "drizzle-orm";
import { http, HttpResponse } from "msw";

import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramMessages } from "@vm0/db/schema/telegram-message";
import { telegramThreadSessions } from "@vm0/db/schema/telegram-thread-session";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { userCache } from "@vm0/db/schema/user-cache";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { createFixtureTracker } from "./helpers/zero-route-test";
import { encryptSecretForTests } from "./helpers/encrypt-secret";

const context = testContext();
const store = createStore();

interface TelegramProbeFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly versionId: string;
  readonly botId: string;
  readonly telegramUserId: string;
}

interface TelegramRunRow {
  readonly id: string;
  readonly prompt: string;
  readonly appendSystemPrompt: string | null;
  readonly triggerSource: string | null;
}

function requestApp(path: string, init?: RequestInit): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return Promise.resolve(app.request(path, init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function uniqueNumericId(): string {
  return String(100_000_000 + Math.floor(Math.random() * 899_999_999));
}

async function cleanupFixture(fixture: TelegramProbeFixture): Promise<void> {
  const db = store.set(writeDb$);
  const runRows = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.orgId, fixture.orgId));
  const runIds = runRows.map((run) => {
    return run.id;
  });
  if (runIds.length > 0) {
    await db
      .delete(agentRunCallbacks)
      .where(inArray(agentRunCallbacks.runId, runIds));
    await db
      .delete(runnerJobQueue)
      .where(inArray(runnerJobQueue.runId, runIds));
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
    .delete(telegramThreadSessions)
    .where(eq(telegramThreadSessions.chatId, "900100200"));
  await db
    .delete(telegramMessages)
    .where(eq(telegramMessages.installationId, fixture.botId));
  await db
    .delete(telegramUserLinks)
    .where(eq(telegramUserLinks.installationId, fixture.botId));
  await db
    .delete(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, fixture.botId));
  await db
    .delete(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, fixture.orgId),
        eq(orgMembersMetadata.userId, fixture.userId),
      ),
    );
  await db.delete(userCache).where(eq(userCache.userId, fixture.userId));
  await db.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
  await db.delete(zeroAgents).where(eq(zeroAgents.id, fixture.composeId));
  await db
    .update(agentComposes)
    .set({ headVersionId: null })
    .where(eq(agentComposes.id, fixture.composeId));
  await db
    .delete(agentComposeVersions)
    .where(eq(agentComposeVersions.id, fixture.versionId));
  await db.delete(agentComposes).where(eq(agentComposes.id, fixture.composeId));
}

const trackFixture = createFixtureTracker(cleanupFixture);

async function seedTelegramProbeFixture(): Promise<TelegramProbeFixture> {
  const db = store.set(writeDb$);
  const userId = `user_${randomUUID().slice(0, 8)}`;
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const composeId = randomUUID();
  const versionId = randomUUID();
  const botId = uniqueNumericId();
  const telegramUserId = uniqueNumericId();
  const agentName = `telegram-probe-${randomUUID().slice(0, 8)}`;

  await db.insert(userCache).values({
    userId,
    email: "telegram-probe@example.com",
    name: "Telegram Probe",
  });
  await db.insert(orgMembersMetadata).values({
    orgId,
    userId,
    timezone: "America/Los_Angeles",
  });
  await db.insert(orgMetadata).values({
    orgId,
    tier: "free",
    credits: 10_000,
  });
  await db.insert(agentComposes).values({
    id: composeId,
    userId,
    orgId,
    name: agentName,
  });
  await db.insert(agentComposeVersions).values({
    id: versionId,
    composeId,
    createdBy: userId,
    content: {
      version: "1.0",
      agents: {
        [agentName]: {
          framework: "claude-code",
          environment: { ANTHROPIC_API_KEY: "test-key" },
        },
      },
    },
  });
  await db
    .update(agentComposes)
    .set({ headVersionId: versionId })
    .where(eq(agentComposes.id, composeId));
  await db.insert(zeroAgents).values({
    id: composeId,
    orgId,
    owner: userId,
    name: agentName,
    displayName: "Telegram Probe Agent",
    visibility: "public",
  });
  await db.insert(telegramInstallations).values({
    telegramBotId: botId,
    botUsername: "probe_bot",
    encryptedBotToken: encryptSecretForTests("test-bot-token"),
    webhookSecret: "test-webhook-secret",
    defaultComposeId: composeId,
    ownerUserId: userId,
    orgId,
  });
  await db.insert(telegramUserLinks).values({
    installationId: botId,
    telegramUserId,
    telegramUsername: "probe_user",
    telegramDisplayName: "Probe User",
    vm0UserId: userId,
  });

  return { orgId, userId, composeId, versionId, botId, telegramUserId };
}

async function seedFixture(): Promise<TelegramProbeFixture> {
  const fixture = await trackFixture(seedTelegramProbeFixture());
  context.mocks.s3.send.mockResolvedValue({});
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  mockOptionalEnv("VM0_API_URL", "http://localhost:3000");
  mockOptionalEnv("VM0_WEB_URL", "http://localhost:3000");
  return fixture;
}

function mockTelegramTyping(): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  server.use(
    http.post(
      "https://api.telegram.org/bottest-bot-token/sendChatAction",
      async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ok: true, result: true });
      },
    ),
  );
  return bodies;
}

async function latestTelegramRun(
  orgId: string,
): Promise<TelegramRunRow | null> {
  const db = store.set(writeDb$);
  const [run] = await db
    .select({
      id: agentRuns.id,
      prompt: agentRuns.prompt,
      appendSystemPrompt: agentRuns.appendSystemPrompt,
      triggerSource: zeroRuns.triggerSource,
    })
    .from(agentRuns)
    .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .where(eq(agentRuns.orgId, orgId))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return run ?? null;
}

async function callbackPayload(runId: string): Promise<unknown> {
  const db = store.set(writeDb$);
  const [callback] = await db
    .select({ payload: agentRunCallbacks.payload })
    .from(agentRunCallbacks)
    .where(eq(agentRunCallbacks.runId, runId))
    .limit(1);
  return callback?.payload;
}

describe("POST /api/test/telegram-dispatch-probe", () => {
  it("returns 404 when the test endpoint is not allowed", async () => {
    mockEnv("ENV", "production");

    const response = await requestApp("/api/test/telegram-dispatch-probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("returns the legacy required-field error for bad bodies", async () => {
    mockEnv("ENV", "development");

    const response = await requestApp("/api/test/telegram-dispatch-probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(400);
    await expect(
      readJson<{ readonly error: string }>(response),
    ).resolves.toStrictEqual({
      error: "bot_id, chat_id, telegram_user_id, and message_text are required",
    });
  });

  it("dispatches private messages through API-owned Telegram run creation", async () => {
    mockEnv("ENV", "development");
    const fixture = await seedFixture();
    const typingBodies = mockTelegramTyping();

    const response = await requestApp("/api/test/telegram-dispatch-probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bot_id: fixture.botId,
        chat_id: "900100200",
        telegram_user_id: fixture.telegramUserId,
        message_text: "hello dm",
        message_id: 501,
      }),
    });

    expect(response.status).toBe(200);
    await expect(
      readJson<{ readonly ok: true }>(response),
    ).resolves.toStrictEqual({ ok: true });
    expect(typingBodies).toStrictEqual([
      { chat_id: "900100200", action: "typing" },
    ]);

    const run = await latestTelegramRun(fixture.orgId);
    expect(run).toMatchObject({
      prompt: "hello dm",
      triggerSource: "telegram",
    });
    expect(run?.appendSystemPrompt).toContain("Chat type: private");
    expect(run?.appendSystemPrompt).toContain("Root message ID: dm");
    expect(run?.appendSystemPrompt).toContain("Telegram username: @e2e-user");

    await expect(callbackPayload(run!.id)).resolves.toMatchObject({
      installationId: fixture.botId,
      chatId: "900100200",
      messageId: "501",
      rootMessageId: "dm",
      isDM: true,
    });
  });

  it("dispatches group mentions with mention stripping and Telegram metadata", async () => {
    mockEnv("ENV", "development");
    const fixture = await seedFixture();
    mockTelegramTyping();

    const response = await requestApp("/api/test/telegram-dispatch-probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bot_id: fixture.botId,
        chat_id: "900100200",
        telegram_user_id: fixture.telegramUserId,
        message_text: "@probe_bot summarize this",
        message_id: 502,
        chat_type: "group",
        bot_username: "probe_bot",
      }),
    });

    expect(response.status).toBe(200);
    await expect(
      readJson<{ readonly ok: true }>(response),
    ).resolves.toStrictEqual({ ok: true });

    const run = await latestTelegramRun(fixture.orgId);
    expect(run?.prompt).toContain("summarize this");
    expect(run?.prompt).not.toContain("@probe_bot summarize this");
    expect(run?.prompt).toContain("[Telegram entities]");
    expect(run?.appendSystemPrompt).toContain("Chat type: group");
    await expect(callbackPayload(run!.id)).resolves.toMatchObject({
      installationId: fixture.botId,
      chatId: "900100200",
      messageId: "502",
      rootMessageId: null,
      isDM: false,
    });
  });
});
