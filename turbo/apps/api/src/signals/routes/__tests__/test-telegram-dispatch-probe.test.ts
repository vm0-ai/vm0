import { createHash, randomUUID } from "node:crypto";

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
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import type { ApiTestUser } from "./helpers/api-bdd";
import { flushWaitUntilForTest } from "../../context/wait-until";

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
  readonly userLinkId: string;
  readonly defaultAgentId: string;
}

interface TelegramRecentRun {
  readonly id: string;
  readonly status: string;
  readonly triggerSource: string | null;
  readonly promptPreview: string | null;
  readonly sessionId: string;
  readonly chatThreadId: string | null;
}

interface TelegramChatThreadRoute {
  readonly id: string;
  readonly telegramUserLinkId: string;
  readonly chatId: string;
  readonly rootMessageId: string;
  readonly chatThreadId: string;
  readonly agentSessionId: string | null;
  readonly lastProcessedMessageId: string | null;
}

const webhooksApi = createWebhookCallbackApi(context);
const chatApi = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);

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
    userLinkId:
      body.user_link_id ??
      (() => {
        throw new Error("Expected seeded Telegram user link");
      })(),
    defaultAgentId: body.default_agent_id,
  };
}

async function seedFixture(): Promise<TelegramProbeFixture> {
  const fixture = await trackFixture(seedTelegramProbeFixture());
  chatCallbacks.acceptChatObjectStorage();
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  mockOptionalEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
  mockOptionalEnv("VM0_WEB_URL", "http://localhost:3000");
  mockEnv("APP_URL", "http://localhost:3002");
  await requestTelegramStateAction({
    action: "seed-model-policies",
    org_id: fixture.orgId,
    user_id: fixture.userId,
    compose_id: fixture.defaultAgentId,
  });
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
        snapshotGeneration: 1,
        snapshotSequence: 1,
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
      (typeof run.promptPreview === "string" || run.promptPreview === null) &&
      typeof run.sessionId === "string" &&
      (typeof run.chatThreadId === "string" || run.chatThreadId === null)
    );
  });
}

function telegramChatThreadRoutes(
  state: TestTelegramStateResponse,
): TelegramChatThreadRoute[] {
  return state.chat_thread_routes.filter(
    (route): route is TelegramChatThreadRoute => {
      return (
        isRecord(route) &&
        typeof route.id === "string" &&
        typeof route.telegramUserLinkId === "string" &&
        typeof route.chatId === "string" &&
        typeof route.rootMessageId === "string" &&
        typeof route.chatThreadId === "string" &&
        (typeof route.agentSessionId === "string" ||
          route.agentSessionId === null) &&
        (typeof route.lastProcessedMessageId === "string" ||
          route.lastProcessedMessageId === null)
      );
    },
  );
}

function actorForFixture(fixture: TelegramProbeFixture): ApiTestUser {
  return {
    userId: fixture.userId,
    orgId: fixture.orgId,
    orgRole: "org:admin",
    email: `${fixture.userId}@example.test`,
  };
}

function mockTelegramCompletionDelivery(): Record<string, unknown>[] {
  let nextMessageId = 7000;
  const bodies: Record<string, unknown>[] = [];
  server.use(
    http.post(
      `https://api.telegram.org/bot${TELEGRAM_TEST_BOT_TOKEN}/sendMessage`,
      async ({ request }) => {
        nextMessageId += 1;
        bodies.push({
          ...((await request.json()) as Record<string, unknown>),
          mock_result_message_id: nextMessageId,
        });
        return HttpResponse.json({
          ok: true,
          result: {
            message_id: nextMessageId,
            chat: { id: 900_100_200 },
          },
        });
      },
    ),
  );
  return bodies;
}

async function completeClaimedRun(
  claim: Awaited<ReturnType<typeof claimRunnerJob>>,
  cliSessionId: string,
): Promise<void> {
  const authorization = `Bearer ${claim.sandboxToken}`;
  chatCallbacks.mockChatOutputEvents([
    {
      eventType: "assistant",
      sequenceNumber: 0,
      eventData: {
        message: {
          content: [{ type: "text", text: "Telegram canonical reply" }],
        },
      },
    },
  ]);
  const historyHash = createHash("sha256")
    .update(`bdd chat session history ${claim.runId}`)
    .digest("hex");
  await webhooksApi.requestAgentCheckpoint(
    {
      runId: claim.runId,
      cliAgentType: "claude-code",
      cliAgentSessionId: cliSessionId,
      cliAgentSessionHistoryHash: historyHash,
    },
    { authorization },
    [200],
  );
  await webhooksApi.requestAgentComplete(
    { runId: claim.runId, exitCode: 0 },
    { authorization },
    [200],
  );
  await flushWaitUntilForTest();
}

async function dispatchPrivateMessage(
  fixture: TelegramProbeFixture,
  args: { readonly text: string; readonly messageId: number },
): Promise<Response> {
  return await requestApp(ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bot_id: fixture.botId,
      chat_id: "900100200",
      telegram_user_id: fixture.telegramUserId,
      message_text: args.text,
      message_id: args.messageId,
    }),
  });
}

async function requestTelegramStateAction(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await requestTelegramState(
    `${TELEGRAM_STATE_ROUTE}/action`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const result = await readJson<Record<string, unknown>>(response);
  if (response.status !== 200) {
    throw new Error(`Telegram state action failed: ${JSON.stringify(result)}`);
  }
  return result;
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
    mockTelegramCompletionDelivery();

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
          zero_run_origin: "zero_run",
          zero_pre_create_source: "chat_callback_auto_send",
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
          op_type: "api_dispatch_pre_create_zero_load_bootstrap_snapshot_rows",
          span_kind: "nested",
          trigger_source: "telegram",
        }),
        expect.objectContaining({
          op_type: "api_dispatch_pre_create_zero_build_create_run_args",
          span_kind: "nested",
          trigger_source: "telegram",
        }),
        expect.objectContaining({
          op_type: "api_dispatch_prepare_context_feature_switches",
          span_kind: "nested",
          trigger_source: "telegram",
          feature_switch_context_source: "preloaded",
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

  it("serializes Telegram admission and shares one canonical application session with web", async () => {
    mockEnv("ENV", "development");
    const fixture = await seedFixture();
    mockTelegramTyping();
    const sentMessages = mockTelegramCompletionDelivery();

    expect(
      (
        await dispatchPrivateMessage(fixture, {
          text: "canonical first",
          messageId: 601,
        })
      ).status,
    ).toBe(200);
    const first = await claimTelegramRunnerJob(fixture, "canonical first");

    expect(
      (
        await dispatchPrivateMessage(fixture, {
          text: "canonical second",
          messageId: 602,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await dispatchPrivateMessage(fixture, {
          text: "canonical second",
          messageId: 602,
        })
      ).status,
    ).toBe(200);
    let state = await readTelegramState(fixture);
    expect(state.message_count).toBe(2);
    expect(
      recentTelegramRuns(state).filter((run) => {
        return run.promptPreview?.includes("canonical second");
      }),
    ).toHaveLength(0);
    const activeRoute = telegramChatThreadRoutes(state).find((candidate) => {
      return candidate.chatId === "900100200";
    });
    if (!activeRoute) {
      throw new Error("Expected the canonical Telegram DM route");
    }
    const admittedEvents = await chatApi.listThreadEvents(
      actorForFixture(fixture),
      activeRoute.chatThreadId,
    );
    expect(admittedEvents.events).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "input.prompt",
          content: "canonical second",
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "canonical second" }],
          },
        }),
      ]),
    );

    await completeClaimedRun(first, "telegram-cli-first");
    expect(sentMessages.at(-1)).not.toHaveProperty("reply_parameters");
    state = await readTelegramState(fixture);
    const route = telegramChatThreadRoutes(state).find((candidate) => {
      return candidate.chatId === "900100200";
    });
    expect(route).toMatchObject({
      rootMessageId: "dm",
      lastProcessedMessageId: "601",
    });
    expect(route?.agentSessionId).toBeTruthy();
    expect(state.thread_sessions).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rootMessageId: "dm",
          agentSessionId: route?.agentSessionId,
        }),
      ]),
    );

    const second = await claimTelegramRunnerJob(fixture, "canonical second");
    state = await readTelegramState(fixture);
    const firstRun = recentTelegramRuns(state).find((run) => {
      return run.id === first.runId;
    });
    const secondRun = recentTelegramRuns(state).find((run) => {
      return run.id === second.runId;
    });
    expect(secondRun).toMatchObject({
      chatThreadId: route?.chatThreadId,
      sessionId: firstRun?.sessionId,
    });
    await completeClaimedRun(second, "telegram-cli-second");

    const web = await chatApi.requestSendEvent(
      actorForFixture(fixture),
      {
        agentId: fixture.defaultAgentId,
        threadId: route?.chatThreadId ?? "",
        prompt: "web continuation",
      },
      [201],
    );
    expect(web.status).toBe(201);
    if (!("runId" in web.body) || !web.body.runId) {
      throw new Error(`Expected web continuation run: ${JSON.stringify(web)}`);
    }
    const webRunId = web.body.runId;
    state = await readTelegramState(fixture);
    const webRun = recentTelegramRuns(state).find((run) => {
      return run.id === webRunId;
    });
    expect(webRun).toMatchObject({
      chatThreadId: route?.chatThreadId,
      sessionId: firstRun?.sessionId,
    });
  });

  it("seeds the canonical thread from legacy and keeps the compatibility dual-write", async () => {
    mockEnv("ENV", "development");
    const fixture = await seedFixture();
    mockTelegramTyping();
    mockTelegramCompletionDelivery();
    const seeded = await requestTelegramStateAction({
      action: "seed-thread-session",
      chat_id: "900100200",
      root_message_id: "dm",
      user_link_id: fixture.userLinkId,
      org_id: fixture.orgId,
      user_id: fixture.userId,
      compose_id: fixture.defaultAgentId,
    });
    expect(seeded.agent_session_id).toStrictEqual(expect.any(String));

    expect(
      (
        await dispatchPrivateMessage(fixture, {
          text: "legacy continuity",
          messageId: 603,
        })
      ).status,
    ).toBe(200);
    const claim = await claimTelegramRunnerJob(fixture, "legacy continuity");
    const stateBeforeCompletion = await readTelegramState(fixture);
    const run = recentTelegramRuns(stateBeforeCompletion).find((candidate) => {
      return candidate.id === claim.runId;
    });
    expect(run?.sessionId).toBe(seeded.agent_session_id);
    expect(telegramChatThreadRoutes(stateBeforeCompletion)).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rootMessageId: "dm",
          agentSessionId: seeded.agent_session_id,
        }),
      ]),
    );

    await completeClaimedRun(claim, "telegram-cli-legacy");
    const stateAfterCompletion = await readTelegramState(fixture);
    expect(stateAfterCompletion.thread_sessions).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rootMessageId: "dm",
          agentSessionId: seeded.agent_session_id,
        }),
      ]),
    );
    expect(telegramChatThreadRoutes(stateAfterCompletion)).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lastProcessedMessageId: "603",
          agentSessionId: seeded.agent_session_id,
        }),
      ]),
    );
  });

  it("dispatches group mentions with mention stripping and Telegram metadata", async () => {
    mockEnv("ENV", "development");
    const fixture = await seedFixture();
    mockTelegramTyping();
    mockTelegramCompletionDelivery();

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

  it("keeps reply-chain anchors and outbound reply targets on canonical callbacks", async () => {
    mockEnv("ENV", "development");
    const fixture = await seedFixture();
    mockTelegramTyping();
    const sentMessages = mockTelegramCompletionDelivery();

    const firstResponse = await requestApp(ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bot_id: fixture.botId,
        chat_id: "900100201",
        telegram_user_id: fixture.telegramUserId,
        message_text: "@probe_bot start a reply chain",
        message_id: 701,
        chat_type: "group",
        bot_username: "probe_bot",
      }),
    });
    expect(firstResponse.status).toBe(200);
    const first = await claimTelegramRunnerJob(fixture, "start a reply chain");
    const firstRunState = await requestTelegramStateAction({
      action: "get-post-run-state",
      org_id: fixture.orgId,
      user_id: fixture.userId,
      run_id: first.runId,
    });
    expect(firstRunState.callbacks).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          internalKind: "telegram",
          payload: expect.objectContaining({
            messageId: "701",
            isDM: false,
            rootMessageId: null,
          }),
        }),
      ]),
    );
    await completeClaimedRun(first, "telegram-cli-group-first");

    const firstCompletion = sentMessages.at(-1);
    expect(firstCompletion).toBeDefined();
    expect(firstCompletion?.reply_parameters).toStrictEqual({
      message_id: 701,
    });
    const firstBotMessageId = firstCompletion?.mock_result_message_id;
    expect(firstBotMessageId).toStrictEqual(expect.any(Number));
    let state = await readTelegramState(fixture);
    const route = telegramChatThreadRoutes(state).find((candidate) => {
      return candidate.chatId === "900100201";
    });
    expect(route).toMatchObject({
      rootMessageId: String(firstBotMessageId),
      lastProcessedMessageId: "701",
    });

    const secondResponse = await requestApp(ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bot_id: fixture.botId,
        chat_id: "900100201",
        telegram_user_id: fixture.telegramUserId,
        message_text: "continue the chain",
        message_id: 702,
        chat_type: "group",
        bot_username: "probe_bot",
        reply_to_message_id: firstBotMessageId,
        reply_to_bot_username: "probe_bot",
      }),
    });
    expect(secondResponse.status).toBe(200);
    const second = await claimTelegramRunnerJob(fixture, "continue the chain");
    state = await readTelegramState(fixture);
    const firstRun = recentTelegramRuns(state).find((candidate) => {
      return candidate.id === first.runId;
    });
    const secondRun = recentTelegramRuns(state).find((candidate) => {
      return candidate.id === second.runId;
    });
    expect(secondRun).toMatchObject({
      chatThreadId: route?.chatThreadId,
      sessionId: firstRun?.sessionId,
    });

    const messagesBeforeSecondCompletion = sentMessages.length;
    await completeClaimedRun(second, "telegram-cli-group-second");
    expect(sentMessages).toHaveLength(messagesBeforeSecondCompletion + 1);
    const secondCompletion = sentMessages.at(-1);
    expect(secondCompletion?.reply_parameters).toStrictEqual({
      message_id: 702,
    });
    expect(
      telegramChatThreadRoutes(await readTelegramState(fixture)),
    ).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chatId: "900100201",
          rootMessageId: String(secondCompletion?.mock_result_message_id),
          lastProcessedMessageId: "702",
          chatThreadId: route?.chatThreadId,
        }),
      ]),
    );
  });
});
