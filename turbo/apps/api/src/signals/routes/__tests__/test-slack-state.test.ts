import { randomUUID } from "node:crypto";

import { http, HttpResponse } from "msw";
import type {
  TestSlackStateDeleteResponse,
  TestSlackStatePostResponse,
  TestSlackStateResponse,
} from "@vm0/api-contracts/contracts/test-slack-state";
import type {
  TestTelegramStateResponse,
  TestTelegramStateSeedResponse,
} from "@vm0/api-contracts/contracts/test-telegram-state";
import { describe, expect, it } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { testSlackDispatchProbeRoutes } from "../test-slack-dispatch-probe";
import { testSlackMockRoutes } from "../test-slack-mock";
import { testSlackStateRoutes } from "../test-slack-state";
import { testTelegramDispatchProbeRoutes } from "../test-telegram-dispatch-probe";
import { testTelegramStateRoutes } from "../test-telegram-state";
import { createFixtureTracker } from "./helpers/zero-route-test";

const context = testContext();

const SLACK_STATE_ROUTE = "/api/test/slack-state";
const SLACK_DISPATCH_PROBE_ROUTE = "/api/test/slack-dispatch-probe";
const SLACK_MOCK_ROUTE = "/api/test/slack-mock";
const TELEGRAM_STATE_ROUTE = "/api/test/telegram-state";
const TELEGRAM_DISPATCH_PROBE_ROUTE = "/api/test/telegram-dispatch-probe";
const TELEGRAM_TEST_BOT_TOKEN = "123456:e2e-test-bot-token";

interface SlackFixture {
  readonly teamId: string;
  readonly slackUserId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly connectionId: string | null;
  readonly defaultAgentId: string | null;
}

interface TelegramFixture {
  readonly botId: string;
  readonly telegramUserId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly defaultAgentId: string;
}

function suffix(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

function uniqueId(prefix: string): string {
  return `${prefix}_${suffix()}`;
}

function uniqueNumericId(): string {
  return String(100_000_000 + Math.floor(Math.random() * 899_999_999));
}

function requestApp(path: string, init?: RequestInit): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: [
      ...testSlackStateRoutes,
      ...testSlackDispatchProbeRoutes,
      ...testSlackMockRoutes,
      ...testTelegramStateRoutes,
      ...testTelegramDispatchProbeRoutes,
    ],
  });
  return Promise.resolve(app.request(path, init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function postSlackState(body: unknown): Promise<Response> {
  return requestApp(SLACK_STATE_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function postTelegramState(body: unknown): Promise<Response> {
  return requestApp(TELEGRAM_STATE_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readSlackState(teamId: string): Promise<TestSlackStateResponse> {
  const response = await requestApp(
    `${SLACK_STATE_ROUTE}?team_id=${encodeURIComponent(teamId)}`,
  );
  expect(response.status).toBe(200);
  return await readJson<TestSlackStateResponse>(response);
}

async function readTelegramState(
  botId: string,
): Promise<TestTelegramStateResponse> {
  const response = await requestApp(
    `${TELEGRAM_STATE_ROUTE}?bot_id=${encodeURIComponent(botId)}`,
  );
  expect(response.status).toBe(200);
  return await readJson<TestTelegramStateResponse>(response);
}

function mockTestUserMembership(userId: string, orgId: string): void {
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [{ id: userId }],
  });
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [
      { createdAt: 20, organization: { id: uniqueId("org_later") } },
      { createdAt: 10, organization: { id: orgId } },
    ],
  });
}

function configureSlackDispatchMocks(): void {
  context.mocks.s3.send.mockResolvedValue({});
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  mockEnv("VM0_WEB_URL", "https://www.vm0.test");
  mockEnv("APP_URL", "https://app.vm0.test");
  mockEnv("VM0_API_URL", "https://api.vm0.test");
  context.mocks.slack.assistant.threads.setStatus.mockResolvedValue({
    ok: true,
  });
  context.mocks.slack.chat.postMessage.mockResolvedValue({
    ok: true,
    ts: "1710000000.000000",
    channel: "C-test",
  });
  context.mocks.slack.chat.postEphemeral.mockResolvedValue({
    ok: true,
    message_ts: "1710000000.000001",
  });
  context.mocks.slack.conversations.history.mockResolvedValue({
    ok: true,
    messages: [],
  });
  context.mocks.slack.conversations.replies.mockResolvedValue({
    ok: true,
    messages: [],
  });
  context.mocks.slack.users.info.mockResolvedValue({
    ok: true,
    user: {
      profile: {
        display_name: "Slack User",
        email: "slack@example.com",
      },
      tz: "UTC",
    },
  });
}

function mockTelegramTyping(): void {
  server.use(
    http.post(
      `https://api.telegram.org/bot${TELEGRAM_TEST_BOT_TOKEN}/sendChatAction`,
      () => {
        return HttpResponse.json({ ok: true, result: true });
      },
    ),
    http.post(
      `https://api.telegram.org/bot${TELEGRAM_TEST_BOT_TOKEN}/sendMessage`,
      () => {
        return HttpResponse.json({
          ok: true,
          result: { message_id: 1, chat: { id: 900_100_200 } },
        });
      },
    ),
  );
}

async function deleteSlackFixture(fixture: SlackFixture): Promise<void> {
  mockEnv("ENV", "development");
  await requestApp(
    `${SLACK_STATE_ROUTE}?team_id=${encodeURIComponent(fixture.teamId)}`,
    { method: "DELETE" },
  );
}

async function deleteTelegramFixture(fixture: TelegramFixture): Promise<void> {
  mockEnv("ENV", "development");
  await requestApp(
    `${TELEGRAM_STATE_ROUTE}?bot_id=${encodeURIComponent(fixture.botId)}`,
    { method: "DELETE" },
  );
}

const trackSlackFixture = createFixtureTracker(deleteSlackFixture);
const trackTelegramFixture = createFixtureTracker(deleteTelegramFixture);

async function seedSlackFixture(
  options: {
    readonly seedConnection?: boolean;
    readonly seedDefaultAgent?: boolean;
    readonly workspaceName?: string;
    readonly botUserId?: string;
    readonly teamId?: string;
    readonly slackUserId?: string;
    readonly userId?: string;
    readonly orgId?: string;
    readonly email?: string;
  } = {},
): Promise<SlackFixture> {
  const userId = options.userId ?? uniqueId("user");
  const orgId = options.orgId ?? uniqueId("org");
  const teamId = options.teamId ?? uniqueId("T");
  const slackUserId = options.slackUserId ?? uniqueId("U");
  const email = options.email ?? `${userId}@example.test`;
  mockTestUserMembership(userId, orgId);

  const response = await postSlackState({
    team_id: teamId,
    slack_user_id: slackUserId,
    workspace_name: options.workspaceName,
    bot_user_id: options.botUserId,
    email,
    seed_connection: options.seedConnection,
    seed_default_agent: options.seedDefaultAgent,
  });
  const body = await readJson<TestSlackStatePostResponse>(response);
  if (response.status !== 200) {
    throw new Error(
      `Expected Slack state seed to succeed, received ${
        response.status
      }: ${JSON.stringify(body)}`,
    );
  }

  const fixture = {
    teamId: body.team_id,
    slackUserId,
    orgId: body.org_id,
    userId: body.vm0_user_id,
    connectionId: body.connection_id,
    defaultAgentId: body.default_agent_id,
  };
  await trackSlackFixture(Promise.resolve(fixture));
  return fixture;
}

async function seedTelegramFixture(options: {
  readonly userId: string;
  readonly orgId: string;
  readonly email: string;
}): Promise<TelegramFixture> {
  const botId = uniqueId("bot");
  const telegramUserId = uniqueNumericId();
  mockTestUserMembership(options.userId, options.orgId);

  const response = await postTelegramState({
    bot_id: botId,
    telegram_user_id: telegramUserId,
    email: options.email,
    seed_link: true,
  });
  const body = await readJson<TestTelegramStateSeedResponse>(response);
  if (response.status !== 200) {
    throw new Error(
      `Expected Telegram state seed to succeed, received ${
        response.status
      }: ${JSON.stringify(body)}`,
    );
  }

  const fixture = {
    botId: body.bot_id,
    telegramUserId,
    orgId: body.org_id,
    userId: body.vm0_user_id,
    defaultAgentId: body.default_agent_id,
  };
  await trackTelegramFixture(Promise.resolve(fixture));
  return fixture;
}

async function dispatchSlackMessage(args: {
  readonly fixture: SlackFixture;
  readonly text: string;
  readonly channelId?: string;
}): Promise<void> {
  configureSlackDispatchMocks();
  const response = await requestApp(SLACK_DISPATCH_PROBE_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      team_id: args.fixture.teamId,
      channel_id: args.channelId ?? "C-test",
      user_id: args.fixture.slackUserId,
      message_text: args.text,
      message_ts: "1710000000.000000",
      channel_type: "channel",
    }),
  });
  expect(response.status).toBe(200);
  await expect(readJson(response)).resolves.toStrictEqual({ ok: true });
}

async function dispatchTelegramMessage(args: {
  readonly fixture: TelegramFixture;
  readonly text: string;
}): Promise<void> {
  context.mocks.s3.send.mockResolvedValue({});
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  mockOptionalEnv("VM0_API_URL", "http://localhost:3000");
  mockOptionalEnv("VM0_WEB_URL", "http://localhost:3000");
  mockEnv("APP_URL", "http://localhost:3002");
  mockTelegramTyping();
  const response = await requestApp(TELEGRAM_DISPATCH_PROBE_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bot_id: args.fixture.botId,
      chat_id: "900100200",
      telegram_user_id: args.fixture.telegramUserId,
      message_text: args.text,
      message_id: 501,
    }),
  });
  expect(response.status).toBe(200);
  await expect(readJson(response)).resolves.toStrictEqual({ ok: true });
}

async function recordSlackMockCall(args: {
  readonly method: "chat.postEphemeral" | "chat.postMessage";
  readonly teamId: string;
  readonly channelId: string;
  readonly text: string;
}): Promise<void> {
  const response = await requestApp(`${SLACK_MOCK_ROUTE}/${args.method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      team_id: args.teamId,
      channel: args.channelId,
      text: args.text,
    }),
  });
  expect(response.status).toBe(200);
}

describe("GET /api/test/slack-state", () => {
  it("returns 404 outside allowed test environments", async () => {
    mockEnv("ENV", "production");

    const response = await requestApp(`${SLACK_STATE_ROUTE}?team_id=T_DENIED`);

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("requires the preview bypass secret in preview", async () => {
    mockEnv("ENV", "preview");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");

    const denied = await requestApp(`${SLACK_STATE_ROUTE}?team_id=T_PREVIEW`, {
      headers: { "x-vercel-protection-bypass": "wrong" },
    });
    const allowed = await requestApp(`${SLACK_STATE_ROUTE}?team_id=T_PREVIEW`, {
      headers: { "x-vercel-protection-bypass": "preview-secret" },
    });

    expect(denied.status).toBe(404);
    await expect(denied.text()).resolves.toBe("Not found");
    expect(allowed.status).toBe(200);
  });

  it("requires team_id", async () => {
    mockEnv("ENV", "development");

    const response = await requestApp(SLACK_STATE_ROUTE);

    expect(response.status).toBe(400);
    await expect(readJson(response)).resolves.toStrictEqual({
      error: "team_id or org_id query param is required",
    });
  });

  it("returns empty workspace diagnostics for an unknown team", async () => {
    mockEnv("ENV", "development");
    mockOptionalEnv("SLACK_API_URL", "https://slack.example.test/api/");

    const response = await requestApp(`${SLACK_STATE_ROUTE}?team_id=T_UNKNOWN`);
    const body = await readJson<TestSlackStateResponse>(response);

    expect(response.status).toBe(200);
    expect(body.installation).toBeNull();
    expect(body.connections).toStrictEqual([]);
    expect(body.recent_runs).toStrictEqual([]);
    expect(body.org_metadata).toBeNull();
    expect(body.default_agent).toBeNull();
    expect(body.default_compose).toBeNull();
    expect(body.default_compose_version).toBeNull();
    expect(body.resolved_slack_api_url).toBe("https://slack.example.test/api/");
    expect(Array.isArray(body.mock_calls)).toBeTruthy();
  });

  it("resolves the preview Slack mock URL", async () => {
    mockEnv("ENV", "development");
    mockOptionalEnv("E2E_SLACK_MOCK_ENABLED", "true");
    mockOptionalEnv("VERCEL_URL", "preview.vm0.test");

    const response = await requestApp(`${SLACK_STATE_ROUTE}?team_id=T_UNKNOWN`);
    const body = await readJson<TestSlackStateResponse>(response);

    expect(response.status).toBe(200);
    expect(body.resolved_slack_api_url).toBe(
      "https://preview.vm0.test/api/test/slack-mock/",
    );
  });

  it("returns Slack installation diagnostics, recent runs, default agent metadata, and mock calls", async () => {
    mockEnv("ENV", "development");
    const fixture = await seedSlackFixture({
      seedConnection: true,
      seedDefaultAgent: true,
      workspaceName: "E2E Slack Workspace",
      botUserId: "U_BOT",
    });
    await dispatchSlackMessage({
      fixture,
      text: "hello from slack diagnostics",
    });
    await recordSlackMockCall({
      method: "chat.postMessage",
      teamId: fixture.teamId,
      channelId: "C_NEWER",
      text: "newer",
    });
    await recordSlackMockCall({
      method: "chat.postEphemeral",
      teamId: fixture.teamId,
      channelId: "C_OLDER",
      text: "older",
    });

    const body = await readSlackState(fixture.teamId);

    expect(body.installation).toMatchObject({
      slackWorkspaceId: fixture.teamId,
      slackWorkspaceName: "E2E Slack Workspace",
      orgId: fixture.orgId,
      botUserId: "U_BOT",
      installedByUserId: fixture.userId,
    });
    expect(typeof body.installation?.createdAt).toBe("string");
    expect(body.connections).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: fixture.connectionId,
          slackUserId: fixture.slackUserId,
          vm0UserId: fixture.userId,
          dmWelcomeSent: false,
        }),
      ]),
    );
    expect(body.recent_runs).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "pending",
          triggerSource: "slack",
          userId: fixture.userId,
          error: null,
          promptPreview: "hello from slack diagnostics",
        }),
      ]),
    );
    expect(body.org_metadata).toMatchObject({
      orgId: fixture.orgId,
      defaultAgentId: fixture.defaultAgentId,
      credits: 10_000,
      tier: "free",
    });
    expect(body.default_agent).toStrictEqual({
      id: fixture.defaultAgentId,
      name: "e2e-slack-agent",
      orgId: fixture.orgId,
    });
    expect(body.default_compose).toMatchObject({
      id: fixture.defaultAgentId,
      name: "e2e-slack-agent",
    });
    expect(body.default_compose_version).toMatchObject({
      content_keys: expect.arrayContaining(["version", "agents"]),
    });
    expect(body.mock_calls).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "chat.postMessage",
          teamId: fixture.teamId,
          channelId: "C_NEWER",
          bodyJson: expect.objectContaining({ text: "newer" }),
        }),
        expect.objectContaining({
          method: "chat.postEphemeral",
          teamId: fixture.teamId,
          channelId: "C_OLDER",
          bodyJson: expect.objectContaining({ text: "older" }),
        }),
      ]),
    );
  });
});

describe("POST /api/test/slack-state", () => {
  it("returns 404 outside allowed test environments", async () => {
    mockEnv("ENV", "production");

    const response = await postSlackState({
      team_id: "T_DENIED",
      slack_user_id: "U_DENIED",
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("requires team_id and slack_user_id", async () => {
    mockEnv("ENV", "development");

    const response = await postSlackState({
      team_id: "T_MISSING_USER",
      seed_connection: true,
    });

    expect(response.status).toBe(400);
    await expect(readJson(response)).resolves.toStrictEqual({
      error: "team_id and slack_user_id are required to seed a connection",
    });
  });

  it("seeds a Slack installation without optional state", async () => {
    mockEnv("ENV", "development");
    const fixture = await seedSlackFixture({
      workspaceName: "Seeded Workspace",
      botUserId: "U_CUSTOM_BOT",
    });

    expect(fixture.connectionId).toBeNull();
    expect(fixture.defaultAgentId).toBeNull();
    const state = await readSlackState(fixture.teamId);
    expect(state.installation).toMatchObject({
      slackWorkspaceId: fixture.teamId,
      slackWorkspaceName: "Seeded Workspace",
      orgId: fixture.orgId,
      botUserId: "U_CUSTOM_BOT",
      installedByUserId: fixture.userId,
    });
    expect(state.connections).toStrictEqual([]);
    expect(state.org_metadata).toBeNull();
    expect(state.default_agent).toBeNull();
  });

  it("optionally seeds a Slack connection", async () => {
    mockEnv("ENV", "development");
    const fixture = await seedSlackFixture({ seedConnection: true });

    expect(typeof fixture.connectionId).toBe("string");
    expect(fixture.defaultAgentId).toBeNull();
    const state = await readSlackState(fixture.teamId);
    expect(state.connections).toStrictEqual([
      expect.objectContaining({
        id: fixture.connectionId,
        slackUserId: fixture.slackUserId,
        vm0UserId: fixture.userId,
        dmWelcomeSent: false,
      }),
    ]);
  });

  it("optionally seeds the default Slack agent", async () => {
    mockEnv("ENV", "development");
    const fixture = await seedSlackFixture({ seedDefaultAgent: true });

    expect(typeof fixture.defaultAgentId).toBe("string");
    expect(fixture.connectionId).toBeNull();
    const state = await readSlackState(fixture.teamId);
    expect(state.default_agent).toStrictEqual({
      id: fixture.defaultAgentId,
      orgId: fixture.orgId,
      name: "e2e-slack-agent",
    });
    expect(state.default_compose).toMatchObject({
      id: fixture.defaultAgentId,
      name: "e2e-slack-agent",
    });
    expect(state.org_metadata).toMatchObject({
      orgId: fixture.orgId,
      defaultAgentId: fixture.defaultAgentId,
      credits: 10_000,
      tier: "free",
    });
    expect(state.default_compose_version).toMatchObject({
      content_keys: expect.arrayContaining(["version", "agents"]),
    });
  });

  it("is idempotent for existing installations, connections, and default agents", async () => {
    mockEnv("ENV", "development");
    const id = suffix();
    const teamId = `T_IDEMPOTENT_${id}`;
    const slackUserId = `U_IDEMPOTENT_${id}`;
    const orgId = `org_idempotent_${id}`;
    const userId = `user_idempotent_${id}`;
    const email = `${userId}@example.test`;
    mockTestUserMembership(userId, orgId);

    const firstResponse = await postSlackState({
      team_id: teamId,
      slack_user_id: slackUserId,
      email,
      seed_connection: true,
      seed_default_agent: true,
    });
    const first = await readJson<TestSlackStatePostResponse>(firstResponse);
    const fixture = await trackSlackFixture(
      Promise.resolve({
        teamId,
        slackUserId,
        orgId,
        userId,
        connectionId: first.connection_id,
        defaultAgentId: first.default_agent_id,
      }),
    );
    mockTestUserMembership(userId, orgId);
    const secondResponse = await postSlackState({
      team_id: teamId,
      slack_user_id: slackUserId,
      email,
      seed_connection: true,
      seed_default_agent: true,
    });
    const second = await readJson<TestSlackStatePostResponse>(secondResponse);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(typeof first.connection_id).toBe("string");
    expect(typeof first.default_agent_id).toBe("string");
    expect(second.connection_id).toBeNull();
    expect(second.default_agent_id).toBe(first.default_agent_id);

    const state = await readSlackState(fixture.teamId);
    expect(state.installation).toMatchObject({
      slackWorkspaceId: teamId,
      orgId,
      installedByUserId: userId,
    });
    expect(state.connections).toHaveLength(1);
    expect(state.connections[0]).toMatchObject({ id: first.connection_id });
    expect(state.default_agent).toMatchObject({ id: first.default_agent_id });
    expect(state.org_metadata).toMatchObject({
      orgId,
      defaultAgentId: first.default_agent_id,
      credits: 10_000,
    });
  });
});

describe("DELETE /api/test/slack-state", () => {
  it("returns 404 outside allowed test environments", async () => {
    mockEnv("ENV", "production");

    const response = await requestApp(`${SLACK_STATE_ROUTE}?team_id=T_DENIED`, {
      method: "DELETE",
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("requires team_id", async () => {
    mockEnv("ENV", "development");

    const response = await requestApp(SLACK_STATE_ROUTE, { method: "DELETE" });

    expect(response.status).toBe(400);
    await expect(readJson(response)).resolves.toStrictEqual({
      error: "team_id or org_id query param is required",
    });
  });

  it("clears workspace Slack state without deleting mock calls or non-Slack runs", async () => {
    mockEnv("ENV", "development");
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const email = `${userId}@example.test`;
    const slack = await seedSlackFixture({
      userId,
      orgId,
      email,
      seedConnection: true,
      seedDefaultAgent: true,
    });
    await dispatchSlackMessage({
      fixture: slack,
      text: "slack diagnostic run",
    });
    await recordSlackMockCall({
      method: "chat.postMessage",
      teamId: slack.teamId,
      channelId: "C_DELETE",
      text: "still visible",
    });
    const telegram = await seedTelegramFixture({ userId, orgId, email });
    await dispatchTelegramMessage({
      fixture: telegram,
      text: "telegram diagnostic run",
    });

    const response = await requestApp(
      `${SLACK_STATE_ROUTE}?team_id=${slack.teamId}`,
      { method: "DELETE" },
    );
    const body = await readJson<TestSlackStateDeleteResponse>(response);

    expect(response.status).toBe(200);
    expect(body).toStrictEqual({ ok: true });

    const deletedSlack = await readSlackState(slack.teamId);
    expect(deletedSlack.installation).toBeNull();
    expect(deletedSlack.connections).toStrictEqual([]);
    expect(deletedSlack.recent_runs).toStrictEqual([]);
    expect(deletedSlack.mock_calls).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "chat.postMessage",
          teamId: slack.teamId,
          channelId: "C_DELETE",
          bodyJson: expect.objectContaining({ text: "still visible" }),
        }),
      ]),
    );

    const telegramState = await readTelegramState(telegram.botId);
    expect(telegramState.recent_runs).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          triggerSource: "telegram",
          promptPreview: "telegram diagnostic run",
        }),
      ]),
    );
    expect(telegramState.recent_runs).not.toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          triggerSource: "slack",
          promptPreview: "slack diagnostic run",
        }),
      ]),
    );
  });

  it("clears API-visible default Slack agent state after delete", async () => {
    mockEnv("ENV", "development");
    const fixture = await seedSlackFixture({ seedDefaultAgent: true });
    const seededState = await readSlackState(fixture.teamId);

    expect(seededState.default_agent).toMatchObject({
      id: fixture.defaultAgentId,
    });
    expect(seededState.default_compose).toMatchObject({
      id: fixture.defaultAgentId,
    });

    const deleteResponse = await requestApp(
      `${SLACK_STATE_ROUTE}?team_id=${fixture.teamId}`,
      { method: "DELETE" },
    );

    expect(deleteResponse.status).toBe(200);
    await expect(readJson(deleteResponse)).resolves.toStrictEqual({
      ok: true,
    });
    const deletedState = await readSlackState(fixture.teamId);
    expect(deletedState.installation).toBeNull();
    expect(deletedState.default_agent).toBeNull();
    expect(deletedState.default_compose).toBeNull();
    expect(deletedState.default_compose_version).toBeNull();
  });
});
