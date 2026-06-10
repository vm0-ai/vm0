import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { testSlackStateContract } from "@vm0/api-contracts/contracts/test-slack-state";
import {
  testTelegramStateContract,
  type TestTelegramStateResponse,
  type TestTelegramStateSeedResponse,
} from "@vm0/api-contracts/contracts/test-telegram-state";
import { testTelegramMockContract } from "@vm0/api-contracts/contracts/test-telegram-mock";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const ROUTE = "/api/test/telegram-state";

interface SeededTelegramState {
  readonly botId: string;
  readonly response: TestTelegramStateSeedResponse;
}

interface SeededSlackState {
  readonly teamId: string;
  readonly defaultAgentId: string | null;
  readonly userId: string;
  readonly orgId: string;
}

function stateClient() {
  return setupApp({ context })(testTelegramStateContract);
}

function telegramMockClient() {
  return setupApp({ context })(testTelegramMockContract);
}

function slackStateClient() {
  return setupApp({ context })(testSlackStateContract);
}

function agentByIdClient() {
  return setupApp({ context })(zeroAgentsByIdContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function suffix(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

function prefixedBotToken(token: string): string {
  return `bot${token}`;
}

function rawRequest(path: string, init?: RequestInit): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return Promise.resolve(app.request(path, init));
}

function mockClerkTestUser(args: {
  readonly userId: string;
  readonly orgId: string;
}): void {
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [{ id: args.userId }],
  });
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [
      { createdAt: 2, organization: { id: `org_ignored_${suffix()}` } },
      { createdAt: 1, organization: { id: args.orgId } },
    ],
  });
}

async function deleteDefaultAgent(args: {
  readonly agentId: string | null;
  readonly userId: string;
  readonly orgId: string;
}): Promise<void> {
  if (!args.agentId) {
    return;
  }

  mocks.clerk.session(args.userId, args.orgId, "org:admin");
  mocks.s3.listObjects([]);
  await accept(
    agentByIdClient().delete({
      params: { id: args.agentId },
      headers: authHeaders(),
    }),
    [204, 404, 409],
  );
}

async function cleanupTelegramState(
  seeded: SeededTelegramState,
): Promise<void> {
  mockEnv("ENV", "development");
  await accept(
    stateClient().delete({ query: { bot_id: seeded.botId } }),
    [200],
  );
  await deleteDefaultAgent({
    agentId: seeded.response.default_agent_id,
    userId: seeded.response.vm0_user_id,
    orgId: seeded.response.org_id,
  });
}

async function cleanupSlackState(seeded: SeededSlackState): Promise<void> {
  mockEnv("ENV", "development");
  await accept(
    slackStateClient().delete({ query: { team_id: seeded.teamId } }),
    [200],
  );
  await deleteDefaultAgent({
    agentId: seeded.defaultAgentId,
    userId: seeded.userId,
    orgId: seeded.orgId,
  });
}

const trackTelegramState =
  createFixtureTracker<SeededTelegramState>(cleanupTelegramState);
const trackSlackState =
  createFixtureTracker<SeededSlackState>(cleanupSlackState);

async function seedTelegramState(args: {
  readonly botId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly telegramUserId: string;
  readonly email?: string;
  readonly botUsername?: string;
  readonly webhookSecret?: string;
  readonly seedLink?: boolean;
  readonly seedMessage?: boolean;
  readonly seedTelegramRun?: boolean;
  readonly seedSlackRun?: boolean;
}): Promise<TestTelegramStateSeedResponse> {
  mockEnv("ENV", "development");
  mockClerkTestUser({ userId: args.userId, orgId: args.orgId });

  const response = await accept(
    stateClient().post({
      body: {
        bot_id: args.botId,
        telegram_user_id: args.telegramUserId,
        bot_username: args.botUsername,
        webhook_secret: args.webhookSecret,
        email: args.email,
        seed_link: args.seedLink,
        seed_message: args.seedMessage,
        seed_telegram_run: args.seedTelegramRun,
        seed_slack_run: args.seedSlackRun,
      },
    }),
    [200],
  );

  await trackTelegramState(
    Promise.resolve({ botId: args.botId, response: response.body }),
  );
  return response.body;
}

async function seedSlackState(args: {
  readonly teamId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly email: string;
}): Promise<string | null> {
  mockEnv("ENV", "development");
  mockClerkTestUser({ userId: args.userId, orgId: args.orgId });

  const response = await accept(
    slackStateClient().post({
      body: {
        team_id: args.teamId,
        slack_user_id: "U_TELEGRAM_RACE",
        email: args.email,
        seed_connection: true,
        seed_default_agent: true,
      },
    }),
    [200],
  );

  await trackSlackState(
    Promise.resolve({
      teamId: args.teamId,
      defaultAgentId: response.body.default_agent_id,
      userId: response.body.vm0_user_id,
      orgId: response.body.org_id,
    }),
  );
  return response.body.default_agent_id;
}

async function readState(botId: string): Promise<TestTelegramStateResponse> {
  const response = await accept(
    stateClient().get({ query: { bot_id: botId } }),
    [200],
  );
  return response.body;
}

function findRun(
  state: TestTelegramStateResponse,
  runId: string,
): TestTelegramStateResponse["recent_runs"][number] | undefined {
  return state.recent_runs.find((run) => {
    return run.id === runId;
  });
}

function findMockCall(
  state: TestTelegramStateResponse,
  args: { readonly botToken: string; readonly method: string },
): TestTelegramStateResponse["mock_calls"][number] | undefined {
  return state.mock_calls.find((call) => {
    return call.botToken === args.botToken && call.method === args.method;
  });
}

describe("/api/test/telegram-state BDD", () => {
  it("gates the test endpoint and returns empty diagnostics for unknown bots", async () => {
    mockEnv("ENV", "production");

    const hiddenGet = await accept(
      stateClient().get({ query: { bot_id: "bot_denied" } }),
      [404],
    );
    const hiddenPost = await accept(
      stateClient().post({
        body: { bot_id: "bot_denied", telegram_user_id: "telegram_denied" },
      }),
      [404],
    );
    const hiddenDelete = await accept(
      stateClient().delete({ query: { bot_id: "bot_denied" } }),
      [404],
    );

    expect(hiddenGet.body).toBe("Not found");
    expect(hiddenPost.body).toBe("Not found");
    expect(hiddenDelete.body).toBe("Not found");

    mockEnv("ENV", "preview");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
    const deniedPreview = await rawRequest(`${ROUTE}?bot_id=bot_preview`, {
      headers: { "x-vercel-protection-bypass": "wrong" },
    });
    const allowedPreview = await rawRequest(`${ROUTE}?bot_id=bot_preview`, {
      headers: { "x-vercel-protection-bypass": "preview-secret" },
    });

    expect(deniedPreview.status).toBe(404);
    await expect(deniedPreview.text()).resolves.toBe("Not found");
    expect(allowedPreview.status).toBe(200);

    mockEnv("ENV", "development");
    const missingBot = await accept(stateClient().get({ query: {} }), [400]);
    const missingDeleteBot = await accept(
      stateClient().delete({ query: {} }),
      [400],
    );
    const missingPostFields = await accept(
      stateClient().post({ body: { bot_id: "bot_missing_user" } }),
      [400],
    );

    expect(missingBot.body).toStrictEqual({
      error: "bot_id query param is required",
    });
    expect(missingDeleteBot.body).toStrictEqual({
      error: "bot_id query param is required",
    });
    expect(missingPostFields.body).toStrictEqual({
      error: "bot_id and telegram_user_id are required",
    });

    const unknown = await readState(`bot_unknown_${suffix()}`);

    expect(unknown.installation).toBeNull();
    expect(unknown.links).toStrictEqual([]);
    expect(unknown.message_count).toBe(0);
    expect(unknown.recent_runs).toStrictEqual([]);
    expect(unknown.org_metadata).toBeNull();
    expect(unknown.default_agent).toBeNull();
    expect(unknown.default_compose).toBeNull();
    expect(unknown.default_compose_version).toBeNull();
    expect(unknown.resolved_telegram_api_url).toBeNull();
    expect(Array.isArray(unknown.mock_calls)).toBeTruthy();

    mockOptionalEnv("TELEGRAM_API_URL", "https://telegram.test/bot");
    const explicitApiUrl = await readState(`bot_unknown_${suffix()}`);

    expect(explicitApiUrl.resolved_telegram_api_url).toBe(
      "https://telegram.test/bot",
    );

    mockOptionalEnv("TELEGRAM_API_URL", undefined);
    mockOptionalEnv("E2E_TELEGRAM_MOCK_ENABLED", "true");
    mockOptionalEnv("VERCEL_URL", "preview.vm0.test");
    const previewMock = await readState(`bot_unknown_${suffix()}`);

    expect(previewMock.resolved_telegram_api_url).toBe(
      "https://preview.vm0.test/api/test/telegram-mock/bot",
    );
  });

  it("seeds, reads, and clears Telegram state through route-visible diagnostics", async () => {
    mockEnv("ENV", "development");
    mockOptionalEnv("TELEGRAM_API_URL", "https://telegram.test/bot");
    const id = suffix();
    const botId = `bot_${id}`;
    const userId = `user_${id}`;
    const orgId = `org_${id}`;
    const telegramUserId = `telegram_${id}`;
    const email = `${id}@example.test`;

    const seeded = await seedTelegramState({
      botId,
      userId,
      orgId,
      telegramUserId,
      email,
      botUsername: "custom_test_bot",
      webhookSecret: "custom-webhook-secret",
      seedMessage: true,
      seedTelegramRun: true,
      seedSlackRun: true,
    });

    expect(seeded).toMatchObject({
      ok: true,
      bot_id: botId,
      org_id: orgId,
      vm0_user_id: userId,
      user_link_id: expect.any(String),
      default_agent_id: expect.any(String),
      message_id: expect.any(String),
      telegram_run_id: expect.any(String),
      slack_run_id: expect.any(String),
    });
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
      emailAddress: [email],
    });

    const botToken = `123456:${id}`;
    await accept(
      telegramMockClient().post({
        params: {
          botToken: prefixedBotToken(botToken),
          method: "sendMessage",
        },
        body: {
          chat_id: `chat_${id}`,
          text: "hello telegram",
        },
      }),
      [200],
    );

    const state = await readState(botId);

    expect(state.installation).toMatchObject({
      telegramBotId: botId,
      botUsername: "custom_test_bot",
      orgId,
      ownerUserId: userId,
      defaultComposeId: seeded.default_agent_id,
    });
    expect(state.links).toMatchObject([
      {
        id: seeded.user_link_id,
        telegramUserId,
        vm0UserId: userId,
        dmWelcomeSent: false,
      },
    ]);
    expect(state.message_count).toBe(1);
    expect(state.org_metadata).toStrictEqual({
      orgId,
      defaultAgentId: seeded.default_agent_id,
      credits: 10_000,
      tier: "free",
    });
    expect(state.default_agent).toMatchObject({
      id: seeded.default_agent_id,
      name: "e2e-slack-agent",
      orgId,
    });
    expect(state.default_compose).toMatchObject({
      id: seeded.default_agent_id,
      name: "e2e-slack-agent",
    });
    expect(state.default_compose_version?.content_keys).toStrictEqual(
      expect.arrayContaining(["version", "agents"]),
    );
    expect(state.resolved_telegram_api_url).toBe("https://telegram.test/bot");

    const telegramRun = seeded.telegram_run_id
      ? findRun(state, seeded.telegram_run_id)
      : undefined;
    const slackRun = seeded.slack_run_id
      ? findRun(state, seeded.slack_run_id)
      : undefined;
    expect(telegramRun).toMatchObject({
      status: "completed",
      triggerSource: "telegram",
      userId,
      promptPreview: "telegram diagnostic run",
    });
    expect(slackRun).toMatchObject({
      status: "completed",
      triggerSource: "slack",
      userId,
      promptPreview: "slack diagnostic run",
    });
    expect(
      findMockCall(state, { botToken, method: "sendMessage" }),
    ).toMatchObject({
      botToken,
      chatId: `chat_${id}`,
      bodyJson: {
        chat_id: `chat_${id}`,
        text: "hello telegram",
      },
    });

    const idempotent = await seedTelegramState({
      botId,
      userId,
      orgId,
      telegramUserId,
      email,
      seedLink: false,
    });

    expect(idempotent.user_link_id).toBeNull();
    expect(idempotent.default_agent_id).toBe(seeded.default_agent_id);
    expect((await readState(botId)).links).toHaveLength(1);

    const unknownDelete = await accept(
      stateClient().delete({ query: { bot_id: `bot_missing_${id}` } }),
      [200],
    );

    expect(unknownDelete.body).toStrictEqual({ ok: true });
    expect((await readState(botId)).installation).toMatchObject({
      telegramBotId: botId,
    });

    const deleted = await accept(
      stateClient().delete({ query: { bot_id: botId } }),
      [200],
    );

    expect(deleted.body).toStrictEqual({ ok: true });

    const cleared = await readState(botId);

    expect(cleared.installation).toBeNull();
    expect(cleared.links).toStrictEqual([]);
    expect(cleared.message_count).toBe(0);
    expect(cleared.recent_runs).toStrictEqual([]);

    const reseeded = await seedTelegramState({
      botId,
      userId,
      orgId,
      telegramUserId,
      email,
      seedLink: false,
    });
    const afterReseed = await readState(botId);

    expect(reseeded.default_agent_id).toBe(seeded.default_agent_id);
    expect(
      seeded.telegram_run_id
        ? findRun(afterReseed, seeded.telegram_run_id)
        : undefined,
    ).toBeUndefined();
    expect(
      seeded.slack_run_id ? findRun(afterReseed, seeded.slack_run_id) : null,
    ).toMatchObject({
      triggerSource: "slack",
      promptPreview: "slack diagnostic run",
    });
  });

  it("reuses the shared default agent during Telegram and Slack preflight races", async () => {
    mockEnv("ENV", "development");
    const id = suffix();
    const userId = `user_race_${id}`;
    const orgId = `org_race_${id}`;
    const email = `${id}@example.test`;
    const botId = `bot_race_${id}`;
    const telegramUserId = `telegram_race_${id}`;

    mockClerkTestUser({ userId, orgId });
    const telegramResponses = await Promise.all(
      Array.from({ length: 8 }, () => {
        return stateClient().post({
          body: {
            bot_id: botId,
            telegram_user_id: telegramUserId,
            email,
            seed_link: true,
          },
        });
      }),
    );

    const telegramBodies = await Promise.all(
      telegramResponses.map(async (response) => {
        return (await accept(Promise.resolve(response), [200])).body;
      }),
    );
    const defaultAgentIds = telegramBodies.map((body) => {
      return body.default_agent_id;
    });
    const firstTelegramBody = telegramBodies[0];
    if (!firstTelegramBody) {
      throw new Error("Expected at least one Telegram race response");
    }
    await trackTelegramState(
      Promise.resolve({
        botId,
        response: firstTelegramBody,
      }),
    );

    expect(new Set(defaultAgentIds).size).toBe(1);

    const mixedId = suffix();
    const mixedTeamId = `T_${mixedId}`;
    const mixedBotId = `bot_mixed_${mixedId}`;

    const [slackDefaultAgentId, telegramRaceBody] = await Promise.all([
      seedSlackState({
        teamId: mixedTeamId,
        userId,
        orgId,
        email,
      }),
      seedTelegramState({
        botId: mixedBotId,
        userId,
        orgId,
        telegramUserId: `telegram_mixed_${mixedId}`,
        email,
      }),
    ]);

    expect(slackDefaultAgentId).toBe(telegramRaceBody.default_agent_id);
    expect(slackDefaultAgentId).not.toBeNull();
  });
});
