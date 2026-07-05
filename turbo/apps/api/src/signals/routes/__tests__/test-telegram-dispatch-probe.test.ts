import { randomUUID } from "node:crypto";

import { http, HttpResponse } from "msw";
import {
  runnersHeartbeatContract,
  runnersJobClaimContract,
} from "@vm0/api-contracts/contracts/runners";
import type {
  TestTelegramStateResponse,
  TestTelegramStateSeedResponse,
} from "@vm0/api-contracts/contracts/test-telegram-state";

import { createAppWithRoutes } from "../../../app-factory-core";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { accept, testContext } from "../../../__tests__/test-context";
import { runnersRoutes } from "../runners";
import { testTelegramDispatchProbeRoutes } from "../test-telegram-dispatch-probe";
import { testTelegramStateRoutes } from "../test-telegram-state";
import { createFixtureTracker } from "./helpers/zero-route-test";

const context = testContext();
const ROUTE = "/api/test/telegram-dispatch-probe";
const TELEGRAM_STATE_ROUTE = "/api/test/telegram-state";
const TELEGRAM_TEST_BOT_TOKEN = "123456:e2e-test-bot-token";
const OFFICIAL_RUNNER_AUTHORIZATION =
  "Bearer vm0_official_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

interface TelegramProbeFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly botId: string;
  readonly telegramUserId: string;
  readonly defaultAgentId: string;
}

interface TelegramRecentRun {
  readonly id: string;
  readonly status: string;
  readonly triggerSource: string | null;
  readonly promptPreview: string | null;
}

function requestApp(path: string, init?: RequestInit): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testTelegramDispatchProbeRoutes,
  });
  return Promise.resolve(app.request(path, init));
}

function requestTelegramState(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testTelegramStateRoutes,
  });
  return Promise.resolve(app.request(path, init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function uniqueNumericId(): string {
  return String(100_000_000 + Math.floor(Math.random() * 899_999_999));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function apiDispatchTimingEventsForRun(
  runId: string,
): readonly Record<string, unknown>[] {
  return context.mocks.axiom.sdkIngest.mock.calls.flatMap((call) => {
    const dataset = call[0];
    const events = call[1];
    if (dataset !== "vm0-sandbox-op-log-dev" || !Array.isArray(events)) {
      return [];
    }
    return events.filter((event): event is Record<string, unknown> => {
      return isRecord(event) && event.run_id === runId;
    });
  });
}

const trackFixture = createFixtureTracker(cleanupFixture);

function mockTestUserMembership(userId: string, orgId: string): void {
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [{ id: userId }],
  });
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [{ createdAt: 10, organization: { id: orgId } }],
  });
}

async function cleanupFixture(fixture: TelegramProbeFixture): Promise<void> {
  mockEnv("ENV", "development");
  await requestTelegramState(
    `${TELEGRAM_STATE_ROUTE}?bot_id=${encodeURIComponent(fixture.botId)}`,
    { method: "DELETE" },
  );
}

async function seedTelegramProbeFixture(): Promise<TelegramProbeFixture> {
  const userId = `user_${randomUUID().slice(0, 8)}`;
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const botId = uniqueNumericId();
  const telegramUserId = uniqueNumericId();
  mockTestUserMembership(userId, orgId);

  const response = await requestTelegramState(TELEGRAM_STATE_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bot_id: botId,
      telegram_user_id: telegramUserId,
      bot_username: "probe_bot",
      webhook_secret: "test-webhook-secret",
      email: `${userId}@example.test`,
      seed_link: true,
    }),
  });
  const body = await readJson<TestTelegramStateSeedResponse>(response);
  if (response.status !== 200) {
    throw new Error(
      `Expected Telegram state seed to succeed, received ${
        response.status
      }: ${JSON.stringify(body)}`,
    );
  }

  return {
    orgId: body.org_id,
    userId: body.vm0_user_id,
    botId: body.bot_id,
    telegramUserId,
    defaultAgentId: body.default_agent_id,
  };
}

async function seedFixture(): Promise<TelegramProbeFixture> {
  const fixture = await trackFixture(seedTelegramProbeFixture());
  context.mocks.s3.send.mockResolvedValue({});
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  mockOptionalEnv("VM0_API_URL", "http://localhost:3000");
  mockOptionalEnv("VM0_WEB_URL", "http://localhost:3000");
  mockEnv("APP_URL", "http://localhost:3002");
  return fixture;
}

function mockTelegramTyping(): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  server.use(
    http.post(
      `https://api.telegram.org/bot${TELEGRAM_TEST_BOT_TOKEN}/sendChatAction`,
      async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ok: true, result: true });
      },
    ),
  );
  return bodies;
}

async function heartbeatRunner() {
  return await accept(
    setupAppWithRoutes({ context, routes: runnersRoutes })(
      runnersHeartbeatContract,
    ).heartbeat({
      headers: { authorization: OFFICIAL_RUNNER_AUTHORIZATION },
      body: {
        runnerId: randomUUID(),
        runnerName: "telegram-dispatch-probe-runner",
        group: "vm0/test",
        admittableProfiles: ["vm0/default"],
        totalVcpu: 8,
        totalMemoryMb: 16_384,
        maxConcurrent: 2,
        allocatedVcpu: 0,
        allocatedMemoryMb: 0,
        runningCount: 0,
        heldSessionStates: [],
        mode: "running",
      },
    }),
    [200],
  );
}

async function claimRunnerJob(runId: string) {
  const response = await accept(
    setupAppWithRoutes({ context, routes: runnersRoutes })(
      runnersJobClaimContract,
    ).claim({
      headers: { authorization: OFFICIAL_RUNNER_AUTHORIZATION },
      params: { id: runId },
      body: {},
    }),
    [200],
  );
  return response.body;
}

async function readTelegramState(
  fixture: TelegramProbeFixture,
): Promise<TestTelegramStateResponse> {
  const response = await requestTelegramState(
    `${TELEGRAM_STATE_ROUTE}?bot_id=${encodeURIComponent(fixture.botId)}`,
  );
  if (response.status !== 200) {
    throw new Error(
      `Expected Telegram state read to succeed: ${response.status}`,
    );
  }
  return await readJson<TestTelegramStateResponse>(response);
}

function recentTelegramRuns(
  state: TestTelegramStateResponse,
): TelegramRecentRun[] {
  return state.recent_runs.filter((run): run is TelegramRecentRun => {
    return (
      isRecord(run) &&
      typeof run.id === "string" &&
      typeof run.status === "string" &&
      (typeof run.triggerSource === "string" || run.triggerSource === null) &&
      (typeof run.promptPreview === "string" || run.promptPreview === null)
    );
  });
}

async function claimTelegramRunnerJob(
  fixture: TelegramProbeFixture,
  expectedPrompt: string,
) {
  await heartbeatRunner();
  const state = await readTelegramState(fixture);
  const run = recentTelegramRuns(state).find((recentRun) => {
    return (
      recentRun.status === "pending" &&
      recentRun.triggerSource === "telegram" &&
      recentRun.promptPreview?.includes(expectedPrompt)
    );
  });
  if (!run) {
    throw new Error(
      `Expected Telegram dispatch probe to enqueue prompt ${JSON.stringify(
        expectedPrompt,
      )}: ${JSON.stringify(state.recent_runs)}`,
    );
  }
  return await claimRunnerJob(run.id);
}

describe("POST /api/test/telegram-dispatch-probe", () => {
  it("returns 404 when the test endpoint is not allowed", async () => {
    mockEnv("ENV", "production");

    const response = await requestApp(ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("returns the legacy required-field error for bad bodies", async () => {
    mockEnv("ENV", "development");

    const response = await requestApp(ROUTE, {
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

    const response = await requestApp(ROUTE, {
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

    const claim = await claimTelegramRunnerJob(fixture, "hello dm");
    expect(claim).toMatchObject({
      prompt: "hello dm",
    });
    expect(claim.appendSystemPrompt).toContain("Chat type: private");
    expect(claim.appendSystemPrompt).toContain("Root message ID: dm");
    expect(claim.appendSystemPrompt).toContain("Telegram username: @e2e-user");
    const state = await readTelegramState(fixture);
    expect(state.message_count).toBe(1);
    expect(recentTelegramRuns(state)).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: claim.runId,
          triggerSource: "telegram",
          promptPreview: "hello dm",
        }),
      ]),
    );

    const timingEvents = apiDispatchTimingEventsForRun(claim.runId);
    expect(timingEvents).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op_type: "api_dispatch_pre_create_agent_run",
          span_kind: "top_level",
          trigger_source: "telegram",
          zero_run_origin: "zero_integration",
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

  it("dispatches group mentions with mention stripping and Telegram metadata", async () => {
    mockEnv("ENV", "development");
    const fixture = await seedFixture();
    mockTelegramTyping();

    const response = await requestApp(ROUTE, {
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

    const claim = await claimTelegramRunnerJob(fixture, "summarize this");
    expect(claim.prompt).toContain("summarize this");
    expect(claim.prompt).not.toContain("@probe_bot summarize this");
    expect(claim.prompt).toContain("[Telegram entities]");
    expect(claim.appendSystemPrompt).toContain("Chat type: group");
    const state = await readTelegramState(fixture);
    expect(state.message_count).toBe(1);
    expect(recentTelegramRuns(state)).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: claim.runId,
          triggerSource: "telegram",
        }),
      ]),
    );
  });
});
