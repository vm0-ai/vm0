import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  chatThreadEventsContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroTeamsConnectContract } from "@vm0/api-contracts/contracts/zero-teams-connect";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  findPendingChatEventByPromptFixture,
  readChatEventContextFixture,
} from "../../../test-fixtures/chat-events";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { zeroTeamsConnectRoutes } from "../zero-teams-connect";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/zero-feature-switches";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  installTeamsForTest,
  postTeamsActivityForTest,
  removeTeamsForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  teamsMessageActivityForTest,
  type TeamsConnectFixture,
} from "./helpers/zero-teams-connect";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const authOrgApi = createAuthOrgAgentsBddApi(context);
const runsApi = createRunsApi(context);
const webhooksApi = createWebhookCallbackApi(context);
const trackTeamsFixture = createFixtureTracker<TeamsConnectFixture>(
  async (fixture) => {
    await removeTeamsForTest(context.signal, fixture);
    await deleteFeatureSwitchesForUser(context, {
      userId: fixture.userId,
      orgId: fixture.orgId,
      orgRole: "org:admin",
    });
  },
);

const APP_URL = "https://app.vm0.test";
const BOT_APP_ID = "00000000-0000-0000-0000-000000000001";
const BOT_APP_PASSWORD = "teams-test-password";
const TEAMS_APP_TENANT_ID = "11111111-1111-1111-1111-111111111111";
const BOT_FRAMEWORK_SCOPE = "https://api.botframework.com/.default";
const MICROSOFT_GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const BOT_FRAMEWORK_TOKEN_URL = `https://login.microsoftonline.com/${TEAMS_APP_TENANT_ID}/oauth2/v2.0/token`;
const MICROSOFT_GRAPH_TOKEN_URL =
  "https://login.microsoftonline.com/:tenantId/oauth2/v2.0/token";

interface TeamsPostedActivity {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly textFormat?: unknown;
  readonly replyToId?: unknown;
  readonly channelData?: unknown;
}

interface TeamsReactionRequest {
  readonly method: "PUT" | "DELETE";
  readonly conversationId: string;
  readonly activityId: string;
  readonly reactionType: string;
}

interface ConnectedTeamsActor {
  readonly fixture: TeamsConnectFixture;
  readonly actor: ReturnType<typeof authOrgApi.user>;
  readonly runnerGroup: string;
  readonly defaultAgentId: string;
}

function teamsServiceBaseUrl(serviceUrl: string): string {
  return serviceUrl.replace(/\/+$/u, "");
}

function recordFromUnknown(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function teamsPostedActivityFromUnknown(value: unknown): TeamsPostedActivity {
  return recordFromUnknown(
    value,
    "Expected Teams outbound activity object",
  ) as TeamsPostedActivity;
}

function teamsApiMocks(args: {
  readonly serviceUrl: string;
  readonly activityStatus?: number;
  readonly activityError?: string;
}): {
  readonly tokenRequests: URLSearchParams[];
  readonly postedActivities: TeamsPostedActivity[];
  readonly reactionRequests: TeamsReactionRequest[];
} {
  const tokenRequests: URLSearchParams[] = [];
  const postedActivities: TeamsPostedActivity[] = [];
  const reactionRequests: TeamsReactionRequest[] = [];
  const serviceBaseUrl = teamsServiceBaseUrl(args.serviceUrl);

  server.use(
    http.post(BOT_FRAMEWORK_TOKEN_URL, async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      expect(form.get("scope")).toBe(BOT_FRAMEWORK_SCOPE);
      tokenRequests.push(form);
      return HttpResponse.json({
        access_token: "teams-access-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }),
    http.post(MICROSOFT_GRAPH_TOKEN_URL, async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      expect(form.get("scope")).toBe(MICROSOFT_GRAPH_SCOPE);
      return HttpResponse.json({
        access_token: "teams-graph-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }),
    http.post(
      `${serviceBaseUrl}/v3/conversations/:conversationId/activities`,
      async ({ request }) => {
        postedActivities.push(
          teamsPostedActivityFromUnknown(await request.json()),
        );
        if (args.activityStatus) {
          return new HttpResponse(args.activityError ?? "Teams API failed", {
            status: args.activityStatus,
          });
        }
        return HttpResponse.json({
          id: `teams-activity-${postedActivities.length}`,
        });
      },
    ),
    http.post(
      `${serviceBaseUrl}/v3/conversations/:conversationId/activities/:activityId`,
      async ({ request }) => {
        postedActivities.push(
          teamsPostedActivityFromUnknown(await request.json()),
        );
        if (args.activityStatus) {
          return new HttpResponse(args.activityError ?? "Teams API failed", {
            status: args.activityStatus,
          });
        }
        return HttpResponse.json({
          id: `teams-activity-${postedActivities.length}`,
        });
      },
    ),
    http.put(
      `${serviceBaseUrl}/v3/conversations/:conversationId/activities/:activityId/reactions/:reactionType`,
      ({ params }) => {
        reactionRequests.push({
          method: "PUT",
          conversationId:
            typeof params.conversationId === "string"
              ? params.conversationId
              : "",
          activityId:
            typeof params.activityId === "string" ? params.activityId : "",
          reactionType:
            typeof params.reactionType === "string" ? params.reactionType : "",
        });
        if (args.activityStatus) {
          return new HttpResponse(args.activityError ?? "Teams API failed", {
            status: args.activityStatus,
          });
        }
        return new HttpResponse(null, { status: 200 });
      },
    ),
    http.delete(
      `${serviceBaseUrl}/v3/conversations/:conversationId/activities/:activityId/reactions/:reactionType`,
      ({ params }) => {
        reactionRequests.push({
          method: "DELETE",
          conversationId:
            typeof params.conversationId === "string"
              ? params.conversationId
              : "",
          activityId:
            typeof params.activityId === "string" ? params.activityId : "",
          reactionType:
            typeof params.reactionType === "string" ? params.reactionType : "",
        });
        if (args.activityStatus) {
          return new HttpResponse(args.activityError ?? "Teams API failed", {
            status: args.activityStatus,
          });
        }
        return new HttpResponse(null, { status: 200 });
      },
    ),
    http.get(
      "https://graph.microsoft.com/v1.0/teams/:teamId/channels/:channelId/messages",
      () => {
        return HttpResponse.json({ value: [] });
      },
    ),
    http.get(
      "https://graph.microsoft.com/v1.0/teams/:teamId/channels/:channelId/messages/:messageId/replies",
      () => {
        return HttpResponse.json({ value: [] });
      },
    ),
    http.get(
      "https://graph.microsoft.com/v1.0/teams/:teamId/channels/:channelId/messages/:messageId",
      ({ params }) => {
        const messageId =
          typeof params.messageId === "string" ? params.messageId : "root";
        return HttpResponse.json({
          id: messageId,
          createdDateTime: "2026-06-30T09:00:00.000Z",
          messageType: "message",
          from: {
            user: {
              id: "29:user-1",
              displayName: "Ada Lovelace",
            },
          },
          body: {
            contentType: "html",
            content: "<p>Teams root context</p>",
          },
        });
      },
    ),
    http.get(
      "https://graph.microsoft.com/v1.0/users/:userId/teamwork/installedApps",
      () => {
        return HttpResponse.json({ value: [] });
      },
    ),
  );

  return { tokenRequests, postedActivities, reactionRequests };
}

function clearTeamsApiCalls(api: ReturnType<typeof teamsApiMocks>): void {
  api.tokenRequests.splice(0, api.tokenRequests.length);
  api.postedActivities.splice(0, api.postedActivities.length);
  api.reactionRequests.splice(0, api.reactionRequests.length);
}

function dropLastTeamsIndicatorRequest(
  api: ReturnType<typeof teamsApiMocks>,
): void {
  const lastActivity = api.postedActivities[api.postedActivities.length - 1];
  if (lastActivity?.type === "typing") {
    api.postedActivities.pop();
    api.tokenRequests.pop();
    return;
  }

  const lastReaction = api.reactionRequests.at(-1);
  expect(lastReaction).toMatchObject({
    method: "PUT",
    reactionType: "1f4ad_thoughtballoon",
  });
  api.reactionRequests.pop();
  api.tokenRequests.pop();
}

function mockOpenRouterSummary(summary: string): unknown[] {
  const requests: unknown[] = [];
  server.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      async ({ request }) => {
        requests.push(await request.json());
        return HttpResponse.json({
          choices: [{ message: { content: summary } }],
        });
      },
    ),
  );
  return requests;
}

async function runIdForPrompt(
  actor: ReturnType<typeof authOrgApi.user>,
  prompt: string,
): Promise<string> {
  const list = await runsApi.listAgentRuns(actor, { limit: 20 });
  const run = list.runs.find((item) => {
    return item.prompt === prompt;
  });
  if (!run) {
    throw new Error(`Expected Teams run for prompt: ${prompt}`);
  }
  return run.id;
}

async function connectTeamsFixture(
  fixture: TeamsConnectFixture,
  options: {
    readonly displayName?: string;
    readonly principalName?: string;
  } = {},
): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
  const client = setupApp({
    context,
    routes: zeroTeamsConnectRoutes,
  })(zeroTeamsConnectContract);
  await accept(
    client.connect({
      headers: { authorization: "Bearer clerk-session" },
      body: {
        tenantId: fixture.teamsTenantId,
        teamsUserId: fixture.teamsUserId,
        teamsUserDisplayName: options.displayName ?? "Ada Lovelace",
        teamsUserPrincipalName: options.principalName ?? "ada@example.com",
        teamId: fixture.teamsTeamId,
        teamName: fixture.teamsTeamName,
        serviceUrl: fixture.serviceUrl,
      },
    }),
    [200],
  );
}

async function setupConnectedTeamsActor(
  options: { readonly zeroDebug?: boolean } = {},
): Promise<ConnectedTeamsActor> {
  const fixture = await trackTeamsFixture(
    Promise.resolve(teamsConnectFixture()),
  );
  const actor = authOrgApi.user({
    userId: fixture.userId,
    orgId: fixture.orgId,
    orgRole: "org:admin",
  });
  const runnerGroup = runsApi.configureRunnerGroup();

  context.mocks.ably.publish.mockResolvedValue(undefined);
  authOrgApi.acceptAgentStorageWrites();
  runsApi.acceptStorageDownloads();
  runsApi.acceptTelemetryIngest();
  const defaultAgent = await authOrgApi.bootstrapLimitedFreeOnboarding(actor, {
    displayName: "Teams callback agent",
  });
  await authOrgApi.updateAgentMetadata(actor, defaultAgent.body.agentId, {
    visibility: "public",
  });
  await runsApi.grantProEntitlement(actor);
  await runsApi.ensureOrgModelProvider(actor);
  if (options.zeroDebug) {
    await updateFeatureSwitchesForUser(
      context,
      {
        userId: fixture.userId,
        orgId: fixture.orgId,
        orgRole: "org:admin",
      },
      {
        [FeatureSwitchKey.ZeroDebug]: true,
      },
    );
  }
  const setupTeamsApi = teamsApiMocks({ serviceUrl: fixture.serviceUrl });
  await installTeamsForTest(context.signal, fixture);
  await flushWaitUntilForTest();
  await connectTeamsFixture(fixture);
  await flushWaitUntilForTest();
  clearTeamsApiCalls(setupTeamsApi);

  return {
    fixture,
    actor,
    runnerGroup,
    defaultAgentId: defaultAgent.body.agentId,
  };
}

async function dispatchTeamsRun(args: {
  readonly fixture: TeamsConnectFixture;
  readonly activityId: string;
  readonly threadId: string;
  readonly text: string;
  readonly senderName?: string;
  readonly senderPrincipalName?: string;
}): Promise<string> {
  const response = await postTeamsActivityForTest({
    signal: context.signal,
    activity: teamsMessageActivityForTest(args.fixture, {
      id: args.activityId,
      replyToId: args.threadId,
      text: `<at>Zero</at> ${args.text}`,
      from: {
        id: args.fixture.teamsUserId,
        name: args.senderName ?? "Ada Lovelace",
        aadObjectId: args.fixture.teamsAadObjectId,
        userPrincipalName: args.senderPrincipalName ?? "ada@example.com",
      },
    }),
  });
  expect(response.status).toBe(200);
  const body = recordFromUnknown(
    await response.json(),
    "Expected Teams bot response object",
  );
  expect(body).not.toHaveProperty("dispatch");
  await flushWaitUntilForTest();
  const actor = authOrgApi.user({
    userId: args.fixture.userId,
    orgId: args.fixture.orgId,
    orgRole: "org:admin",
  });
  return await runIdForPrompt(actor, args.text);
}

async function postTeamsPersonalMessage(args: {
  readonly fixture: TeamsConnectFixture;
  readonly activityId: string;
  readonly threadId?: string;
  readonly text: string;
  readonly omitRecipient?: boolean;
}): Promise<void> {
  const response = await postTeamsActivityForTest({
    signal: context.signal,
    activity: teamsMessageActivityForTest(args.fixture, {
      id: args.activityId,
      conversation: {
        id: `a:personal-${args.fixture.teamsUserId}`,
        conversationType: "personal",
      },
      channelData: {
        tenant: {
          id: args.fixture.teamsTenantId,
          name: args.fixture.teamsTenantName,
        },
        teamsAppId: BOT_APP_ID,
      },
      text: args.text,
      entities: [],
      replyToId: args.threadId ?? null,
      ...(args.omitRecipient ? { recipient: undefined } : {}),
    }),
  });
  expect(response.status).toBe(200);
  const body = recordFromUnknown(
    await response.json(),
    "Expected Teams bot response object",
  );
  expect(body).not.toHaveProperty("dispatch");
  await flushWaitUntilForTest();
}

async function dispatchTeamsPersonalRun(args: {
  readonly fixture: TeamsConnectFixture;
  readonly activityId: string;
  readonly threadId?: string;
  readonly text: string;
}): Promise<string> {
  await postTeamsPersonalMessage(args);
  const actor = authOrgApi.user({
    userId: args.fixture.userId,
    orgId: args.fixture.orgId,
    orgRole: "org:admin",
  });
  return await runIdForPrompt(actor, args.text);
}

async function switchTeamsAgent(args: {
  readonly fixture: TeamsConnectFixture;
  readonly activityId: string;
  readonly agentId: string;
}): Promise<void> {
  const response = await postTeamsActivityForTest({
    signal: context.signal,
    activity: teamsMessageActivityForTest(args.fixture, {
      id: args.activityId,
      conversation: {
        id: `a:personal-${args.fixture.teamsUserId}`,
        conversationType: "personal",
      },
      channelData: {
        tenant: {
          id: args.fixture.teamsTenantId,
          name: args.fixture.teamsTenantName,
        },
        teamsAppId: BOT_APP_ID,
      },
      text: "",
      entities: [],
      value: {
        zeroTeamsAction: "switch_agent",
        selectedComposeId: args.agentId,
      },
    }),
  });
  expect(response.status).toBe(200);
  await response.json();
  await flushWaitUntilForTest();
}

async function claimTeamsRun(args: {
  readonly runnerGroup: string;
  readonly runId: string;
}) {
  await runsApi.heartbeatRunner(args.runnerGroup);
  return await runsApi.claimRunnerJob(args.runId);
}

async function completeSandboxRun(args: {
  readonly runId: string;
  readonly sandboxToken: string;
  readonly exitCode: number;
  readonly error?: string;
}): Promise<string | undefined> {
  const sandboxHeaders = { authorization: `Bearer ${args.sandboxToken}` };
  if (args.exitCode === 0) {
    const cliAgentSessionId = `bdd-teams-cli-${args.runId}`;
    const cliAgentSessionHistory = `bdd teams history ${args.runId}`;
    const cliAgentSessionHistoryHash = createHash("sha256")
      .update(cliAgentSessionHistory)
      .digest("hex");
    const cliAgentSessionHistorySize = Buffer.byteLength(
      cliAgentSessionHistory,
      "utf8",
    );
    await webhooksApi.requestAgentCheckpointPrepareHistory(
      {
        runId: args.runId,
        hash: cliAgentSessionHistoryHash,
        rawSize: cliAgentSessionHistorySize,
        encodedSize: cliAgentSessionHistorySize,
        encoding: "identity",
      },
      sandboxHeaders,
      [200],
    );
    await webhooksApi.requestAgentCheckpoint(
      {
        runId: args.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId,
        cliAgentSessionHistoryHash,
      },
      sandboxHeaders,
      [200],
    );
    await webhooksApi.requestAgentComplete(
      { runId: args.runId, exitCode: args.exitCode },
      sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    return cliAgentSessionId;
  }

  await webhooksApi.requestAgentComplete(
    {
      runId: args.runId,
      exitCode: args.exitCode,
      ...(args.error === undefined ? {} : { error: args.error }),
    },
    sandboxHeaders,
    [200],
  );
  await flushWaitUntilForTest();
  return undefined;
}

async function claimFollowUpInThread(args: {
  readonly fixture: TeamsConnectFixture;
  readonly runnerGroup: string;
  readonly threadId: string;
  readonly activityId: string;
}) {
  const followUpRunId = await dispatchTeamsRun({
    fixture: args.fixture,
    activityId: args.activityId,
    threadId: args.threadId,
    text: "continue in the same thread",
  });
  await runsApi.heartbeatRunner(args.runnerGroup);
  return await runsApi.claimRunnerJob(followUpRunId);
}

beforeEach(() => {
  setupTeamsConnectTestEnv(APP_URL);
  mockEnv("MICROSOFT_TEAMS_BOT_APP_PASSWORD", BOT_APP_PASSWORD);
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  mockEnv("VM0_WEB_URL", "https://www.vm0.test");
  mockEnv("VM0_API_BACKEND_URL", "https://api.vm0.test");
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  context.mocks.axiom.query.mockResolvedValue([]);
});

afterEach(async () => {
  await flushWaitUntilForTest();
  context.mocks.axiom.query.mockReset();
});

describe("Teams chat callbacks", () => {
  it("claims Teams launch material from context with a legacy fallback", async () => {
    const teams = await setupConnectedTeamsActor();
    teamsApiMocks({ serviceUrl: teams.fixture.serviceUrl });
    const firstRunId = await dispatchTeamsPersonalRun({
      fixture: teams.fixture,
      activityId: "activity-queue-params-first",
      text: "hold the Teams queue",
    });
    const firstClaim = await claimTeamsRun({
      runnerGroup: teams.runnerGroup,
      runId: firstRunId,
    });

    const queuedPrompt = "claim Teams launch context";
    await postTeamsPersonalMessage({
      fixture: teams.fixture,
      activityId: "activity-queue-params-second",
      text: queuedPrompt,
    });
    const queuedParams =
      await findPendingChatEventByPromptFixture(queuedPrompt);
    expect(queuedParams).toMatchObject({
      eventId: expect.any(String),
    });
    if (!queuedParams) {
      throw new Error("Expected queued Teams event");
    }
    await expect(
      readChatEventContextFixture(queuedParams.eventId),
    ).resolves.toMatchObject({
      contextType: "teams",
      teamsTenantId: teams.fixture.teamsTenantId,
      teamsTeamId: null,
      teamsChannelId: null,
      teamsConversationId: `a:personal-${teams.fixture.teamsUserId}`,
      teamsConversationType: "personal",
      teamsActivityId: "activity-queue-params-second",
      teamsThreadContext: "",
      teamsMessageText: queuedPrompt,
      teamsMessageFiles: [],
      teamsTenantName: teams.fixture.teamsTenantName,
      teamsTeamName: null,
      teamsThreadId: `direct-message:${teams.defaultAgentId}:claude-sonnet-4-6`,
      teamsServiceUrl: teams.fixture.serviceUrl,
      teamsAppId: BOT_APP_ID,
      teamsBotId: "28:bot-1",
      teamsBotName: "Zero",
      teamsSenderUserId: teams.fixture.teamsUserId,
      teamsSenderDisplayName: "Ada Lovelace",
      teamsSenderPrincipalName: "ada@example.com",
      teamsConnectionId: expect.any(String),
    });
    await completeSandboxRun({
      runId: firstRunId,
      sandboxToken: firstClaim.sandboxToken,
      exitCode: 0,
    });
    const queuedRunId = await runIdForPrompt(teams.actor, queuedPrompt);
    const queuedClaim = await claimTeamsRun({
      runnerGroup: teams.runnerGroup,
      runId: queuedRunId,
    });
    const queuedRun = (
      await runsApi.listAgentRuns(teams.actor, { limit: 20 })
    ).runs.find((run) => {
      return run.id === queuedRunId;
    });
    expect(queuedClaim.prompt).toBe(queuedRun?.prompt);
    expect(queuedClaim.appendSystemPrompt).toBe(queuedRun?.appendSystemPrompt);
    expect(queuedClaim.appendSystemPrompt).toContain(
      "You are currently running inside: Microsoft Teams",
    );
    expect(queuedClaim.appendSystemPrompt).toContain(
      "Thread ID: activity-queue-params-second",
    );

    await completeSandboxRun({
      runId: queuedRunId,
      sandboxToken: queuedClaim.sandboxToken,
      exitCode: 0,
    });
  });

  it("falls back to installation bot identity when the activity omits it", async () => {
    const teams = await setupConnectedTeamsActor();
    teamsApiMocks({ serviceUrl: teams.fixture.serviceUrl });
    const firstRunId = await dispatchTeamsPersonalRun({
      fixture: teams.fixture,
      activityId: "activity-bot-fallback-first",
      text: "hold the Teams bot fallback queue",
    });
    const firstClaim = await claimTeamsRun({
      runnerGroup: teams.runnerGroup,
      runId: firstRunId,
    });

    const queuedPrompt = "claim without an activity recipient";
    await postTeamsPersonalMessage({
      fixture: teams.fixture,
      activityId: "activity-bot-fallback-second",
      text: queuedPrompt,
      omitRecipient: true,
    });
    const queuedParams =
      await findPendingChatEventByPromptFixture(queuedPrompt);
    if (!queuedParams) {
      throw new Error("Expected queued Teams bot fallback event");
    }
    await expect(
      readChatEventContextFixture(queuedParams.eventId),
    ).resolves.toMatchObject({
      teamsBotId: null,
      teamsBotName: null,
    });
    await completeSandboxRun({
      runId: firstRunId,
      sandboxToken: firstClaim.sandboxToken,
      exitCode: 0,
    });
    const queuedRunId = await runIdForPrompt(teams.actor, queuedPrompt);
    const queuedClaim = await claimTeamsRun({
      runnerGroup: teams.runnerGroup,
      runId: queuedRunId,
    });
    expect(queuedClaim.prompt).toBe(queuedPrompt);
    expect(queuedClaim.appendSystemPrompt).toContain("Bot ID: 28:bot-1");
    expect(queuedClaim.appendSystemPrompt).toContain("Bot name: Zero");
    await runsApi.requestCancelRun(teams.actor, queuedRunId, [200]);
  });

  it("keeps personal message sessions scoped to the selected agent", async () => {
    const teams = await setupConnectedTeamsActor();
    const teamsApi = teamsApiMocks({ serviceUrl: teams.fixture.serviceUrl });
    const defaultRunId = await dispatchTeamsPersonalRun({
      fixture: teams.fixture,
      activityId: "activity-personal-default-agent",
      text: "remember this DM context",
    });
    const defaultClaim = await claimTeamsRun({
      runnerGroup: teams.runnerGroup,
      runId: defaultRunId,
    });
    expect(defaultClaim.resumeSession).toBeNull();
    clearTeamsApiCalls(teamsApi);
    const defaultSessionId = await completeSandboxRun({
      runId: defaultRunId,
      sandboxToken: defaultClaim.sandboxToken,
      exitCode: 0,
    });

    const alternateAgent = await authOrgApi.createAgent(teams.actor, {
      displayName: "Alternate Teams DM agent",
      visibility: "public",
    });
    await switchTeamsAgent({
      fixture: teams.fixture,
      activityId: "activity-personal-switch-alternate",
      agentId: alternateAgent.agentId,
    });
    const alternateRunId = await dispatchTeamsPersonalRun({
      fixture: teams.fixture,
      activityId: "activity-personal-alternate-agent",
      text: "use an alternate Teams DM agent",
    });
    const alternateClaim = await claimTeamsRun({
      runnerGroup: teams.runnerGroup,
      runId: alternateRunId,
    });
    expect(alternateClaim.resumeSession).toBeNull();
    clearTeamsApiCalls(teamsApi);
    await completeSandboxRun({
      runId: alternateRunId,
      sandboxToken: alternateClaim.sandboxToken,
      exitCode: 0,
    });
    await switchTeamsAgent({
      fixture: teams.fixture,
      activityId: "activity-personal-switch-default",
      agentId: teams.defaultAgentId,
    });

    const returnToDefaultRunId = await dispatchTeamsPersonalRun({
      fixture: teams.fixture,
      activityId: "activity-personal-default-agent-return",
      text: "return to the default Teams DM agent",
    });
    const returnToDefaultClaim = await claimTeamsRun({
      runnerGroup: teams.runnerGroup,
      runId: returnToDefaultRunId,
    });
    expect(returnToDefaultClaim.resumeSession?.sessionId).toBe(
      defaultSessionId,
    );
  });

  it("forks personal message threads without replacing the main session", async () => {
    const teams = await setupConnectedTeamsActor();
    const teamsApi = teamsApiMocks({ serviceUrl: teams.fixture.serviceUrl });
    const rootActivityId = "activity-personal-main";
    const mainRunId = await dispatchTeamsPersonalRun({
      fixture: teams.fixture,
      activityId: rootActivityId,
      text: "remember the main Teams DM context",
    });
    const mainClaim = await claimTeamsRun({
      runnerGroup: teams.runnerGroup,
      runId: mainRunId,
    });
    expect(mainClaim.resumeSession).toBeNull();
    clearTeamsApiCalls(teamsApi);
    const mainSessionId = await completeSandboxRun({
      runId: mainRunId,
      sandboxToken: mainClaim.sandboxToken,
      exitCode: 0,
    });

    const threadRunId = await dispatchTeamsPersonalRun({
      fixture: teams.fixture,
      activityId: "activity-personal-thread-first",
      threadId: rootActivityId,
      text: "open a personal message thread",
    });
    const threadClaim = await claimTeamsRun({
      runnerGroup: teams.runnerGroup,
      runId: threadRunId,
    });
    expect(threadClaim.resumeSession).toBeNull();
    clearTeamsApiCalls(teamsApi);
    const threadSessionId = await completeSandboxRun({
      runId: threadRunId,
      sandboxToken: threadClaim.sandboxToken,
      exitCode: 0,
    });

    const threadFollowUpRunId = await dispatchTeamsPersonalRun({
      fixture: teams.fixture,
      activityId: "activity-personal-thread-follow-up",
      threadId: rootActivityId,
      text: "continue the personal message thread",
    });
    const threadFollowUpClaim = await claimTeamsRun({
      runnerGroup: teams.runnerGroup,
      runId: threadFollowUpRunId,
    });
    expect(threadFollowUpClaim.resumeSession?.sessionId).toBe(threadSessionId);
    clearTeamsApiCalls(teamsApi);
    await completeSandboxRun({
      runId: threadFollowUpRunId,
      sandboxToken: threadFollowUpClaim.sandboxToken,
      exitCode: 0,
    });

    const returnToMainRunId = await dispatchTeamsPersonalRun({
      fixture: teams.fixture,
      activityId: "activity-personal-main-return",
      text: "return to the main DM",
    });
    const returnToMainClaim = await claimTeamsRun({
      runnerGroup: teams.runnerGroup,
      runId: returnToMainRunId,
    });
    expect(returnToMainClaim.resumeSession?.sessionId).toBe(mainSessionId);
  });

  it("posts completed run replies and persists canonical Teams thread sessions", async () => {
    const teams = await setupConnectedTeamsActor({ zeroDebug: true });
    const teamsApi = teamsApiMocks({ serviceUrl: teams.fixture.serviceUrl });
    mockOptionalEnv("OPENROUTER_API_KEY", "teams-summary-key");
    const summaryRequests = mockOpenRouterSummary("Teams completed summary");
    const runId = await dispatchTeamsRun({
      fixture: teams.fixture,
      activityId: "activity-completed-1",
      threadId: "root-completed",
      text: "finish the task",
    });
    mocks.clerk.session(teams.fixture.userId, teams.fixture.orgId, "org:admin");
    const threadEvents = await accept(
      setupApp({ context })(chatThreadsContract).events({
        headers: { authorization: "Bearer clerk-session" },
        query: {},
      }),
      [200],
    );
    const createdThread = threadEvents.body.events.find((event) => {
      return event.kind === "created";
    });
    if (!createdThread) {
      throw new Error("Expected the canonical Teams chat thread");
    }
    const threadMessages = await accept(
      setupApp({ context })(chatThreadEventsContract).list({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: createdThread.chatThreadId },
        query: {},
      }),
      [200],
    );
    expect(threadMessages.body.events).toContainEqual(
      expect.objectContaining({
        eventType: "input.prompt",
        content: null,
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "finish the task" },
            {
              type: "source",
              kind: "teams",
              href:
                "https://teams.microsoft.com/l/message/" +
                "19%3Achannel%40thread.tacv2/activity-completed-1" +
                `?tenantId=${encodeURIComponent(teams.fixture.teamsTenantId)}`,
            },
          ],
        },
      }),
    );
    const claim = await claimTeamsRun({
      runnerGroup: teams.runnerGroup,
      runId,
    });
    clearTeamsApiCalls(teamsApi);

    await webhooksApi.requestAgentHeartbeat(
      { runId },
      { authorization: `Bearer ${claim.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
    expect(teamsApi.tokenRequests).toHaveLength(0);
    expect(teamsApi.postedActivities).toHaveLength(0);
    expect(teamsApi.reactionRequests).toHaveLength(0);
    clearTeamsApiCalls(teamsApi);

    const cliAgentSessionId = await completeSandboxRun({
      runId,
      sandboxToken: claim.sandboxToken,
      exitCode: 0,
    });

    expect(teamsApi.tokenRequests).toHaveLength(2);
    expect(teamsApi.tokenRequests[0]?.get("client_id")).toBe(BOT_APP_ID);
    expect(teamsApi.tokenRequests[0]?.get("client_secret")).toBe(
      BOT_APP_PASSWORD,
    );
    expect(teamsApi.postedActivities).toHaveLength(1);
    expect(teamsApi.postedActivities[0]).toMatchObject({
      type: "message",
      textFormat: "markdown",
      replyToId: "activity-completed-1",
      channelData: {
        tenant: { id: teams.fixture.teamsTenantId },
      },
    });
    expect(teamsApi.postedActivities[0]?.text).toContain(
      "Task completed successfully.",
    );
    expect(teamsApi.postedActivities[0]?.text).toContain(
      `[Audit](${APP_URL}/activities/${runId})`,
    );
    expect(teamsApi.postedActivities[0]?.text).not.toContain("Reply to");
    expect(teamsApi.reactionRequests).toStrictEqual([
      {
        method: "DELETE",
        conversationId: "19:thread@thread.tacv2",
        activityId: "activity-completed-1",
        reactionType: "1f4ad_thoughtballoon",
      },
    ]);
    const completedThreadMessages = await accept(
      setupApp({ context })(chatThreadEventsContract).list({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: createdThread.chatThreadId },
        query: {},
      }),
      [200],
    );
    expect(completedThreadMessages.body.events).toContainEqual(
      expect.objectContaining({
        eventType: "output.message",
        content: "Task completed successfully.",
      }),
    );
    const summaryRequestValue = summaryRequests.find((request) => {
      const serialized = JSON.stringify(request);
      return serialized.includes("finish the task");
    });
    const summaryRequest = recordFromUnknown(
      summaryRequestValue,
      "Expected Teams run summary request",
    );
    expect(JSON.stringify(summaryRequest.messages)).toContain(
      "finish the task",
    );
    const firstRunOpenRouterRequestCount = summaryRequests.length;

    const secondFixture = await trackTeamsFixture(
      Promise.resolve(
        teamsConnectFixture({
          orgId: teams.fixture.orgId,
          teamsTenantId: teams.fixture.teamsTenantId,
          teamsTenantName: teams.fixture.teamsTenantName,
          teamsTeamId: teams.fixture.teamsTeamId,
          teamsTeamName: teams.fixture.teamsTeamName,
          serviceUrl: teams.fixture.serviceUrl,
        }),
      ),
    );
    authOrgApi.user({
      userId: secondFixture.userId,
      orgId: secondFixture.orgId,
      orgRole: "org:admin",
    });
    const tokenRequestCountBeforeConnect = teamsApi.tokenRequests.length;
    const postedActivityCountBeforeConnect = teamsApi.postedActivities.length;
    await connectTeamsFixture(secondFixture, {
      displayName: "Grace Hopper",
      principalName: "grace@example.com",
    });
    await flushWaitUntilForTest();
    teamsApi.tokenRequests.splice(tokenRequestCountBeforeConnect);
    teamsApi.postedActivities.splice(postedActivityCountBeforeConnect);
    const secondRunId = await dispatchTeamsRun({
      fixture: secondFixture,
      activityId: "activity-completed-2",
      threadId: "root-completed",
      text: "finish the follow-up",
      senderName: "Grace Hopper",
      senderPrincipalName: "grace@example.com",
    });
    const secondClaim = await claimTeamsRun({
      runnerGroup: teams.runnerGroup,
      runId: secondRunId,
    });
    dropLastTeamsIndicatorRequest(teamsApi);
    await completeSandboxRun({
      runId: secondRunId,
      sandboxToken: secondClaim.sandboxToken,
      exitCode: 0,
    });
    expect(teamsApi.postedActivities).toHaveLength(2);
    expect(teamsApi.postedActivities[1]?.text).toContain(
      "Reply to Grace Hopper",
    );
    expect(summaryRequests.length).toBeGreaterThan(
      firstRunOpenRouterRequestCount,
    );

    const followUpClaim = await claimFollowUpInThread({
      fixture: teams.fixture,
      runnerGroup: teams.runnerGroup,
      threadId: "root-completed",
      activityId: "activity-completed-follow-up",
    });
    expect(followUpClaim.resumeSession?.sessionId).toBe(cliAgentSessionId);
  });

  it("posts readable failed run replies without persisting a thread session", async () => {
    const teams = await setupConnectedTeamsActor();
    const teamsApi = teamsApiMocks({ serviceUrl: teams.fixture.serviceUrl });
    const runId = await dispatchTeamsRun({
      fixture: teams.fixture,
      activityId: "activity-failed-1",
      threadId: "root-failed",
      text: "fail this task",
    });
    const claim = await claimTeamsRun({
      runnerGroup: teams.runnerGroup,
      runId,
    });
    clearTeamsApiCalls(teamsApi);

    await completeSandboxRun({
      runId,
      sandboxToken: claim.sandboxToken,
      exitCode: 1,
      error: "Cannot continue session from checkpoint",
    });

    expect(teamsApi.postedActivities).toHaveLength(1);
    expect(teamsApi.postedActivities[0]?.text).toContain(
      "Cannot continue session from checkpoint",
    );
    expect(teamsApi.reactionRequests).toStrictEqual([
      {
        method: "DELETE",
        conversationId: "19:thread@thread.tacv2",
        activityId: "activity-failed-1",
        reactionType: "1f4ad_thoughtballoon",
      },
    ]);

    const followUpClaim = await claimFollowUpInThread({
      fixture: teams.fixture,
      runnerGroup: teams.runnerGroup,
      threadId: "root-failed",
      activityId: "activity-failed-follow-up",
    });
    expect(followUpClaim.resumeSession).toBeNull();
  });

  it("does not post replies when the Teams installation is missing", async () => {
    const teams = await setupConnectedTeamsActor();
    const teamsApi = teamsApiMocks({ serviceUrl: teams.fixture.serviceUrl });
    const runId = await dispatchTeamsRun({
      fixture: teams.fixture,
      activityId: "activity-missing-install-1",
      threadId: "root-missing-install",
      text: "complete after uninstall",
    });
    const claim = await claimTeamsRun({
      runnerGroup: teams.runnerGroup,
      runId,
    });
    clearTeamsApiCalls(teamsApi);
    await removeTeamsForTest(context.signal, teams.fixture);

    await completeSandboxRun({
      runId,
      sandboxToken: claim.sandboxToken,
      exitCode: 0,
    });

    expect(teamsApi.tokenRequests).toHaveLength(0);
    expect(teamsApi.postedActivities).toHaveLength(0);
    expect(teamsApi.reactionRequests).toHaveLength(0);
    await installTeamsForTest(context.signal, teams.fixture);
    await flushWaitUntilForTest();
    await connectTeamsFixture(teams.fixture);
    await flushWaitUntilForTest();
    clearTeamsApiCalls(teamsApi);

    const followUpClaim = await claimFollowUpInThread({
      fixture: teams.fixture,
      runnerGroup: teams.runnerGroup,
      threadId: "root-missing-install",
      activityId: "activity-missing-install-follow-up",
    });
    expect(followUpClaim.resumeSession).toBeNull();
  });

  it("keeps the canonical thread session when the Teams API rejects the reply", async () => {
    const teams = await setupConnectedTeamsActor();
    const teamsApi = teamsApiMocks({
      serviceUrl: teams.fixture.serviceUrl,
      activityStatus: 500,
      activityError: "upstream exploded",
    });
    const runId = await dispatchTeamsRun({
      fixture: teams.fixture,
      activityId: "activity-teams-api-error-1",
      threadId: "root-teams-api-error",
      text: "complete while Teams is down",
    });
    const claim = await claimTeamsRun({
      runnerGroup: teams.runnerGroup,
      runId,
    });
    clearTeamsApiCalls(teamsApi);

    const cliAgentSessionId = await completeSandboxRun({
      runId,
      sandboxToken: claim.sandboxToken,
      exitCode: 0,
    });

    expect(teamsApi.tokenRequests).toHaveLength(2);
    expect(teamsApi.postedActivities).toHaveLength(1);
    expect(teamsApi.postedActivities[0]?.text).toContain(
      "Task completed successfully.",
    );
    expect(teamsApi.reactionRequests).toStrictEqual([
      {
        method: "DELETE",
        conversationId: "19:thread@thread.tacv2",
        activityId: "activity-teams-api-error-1",
        reactionType: "1f4ad_thoughtballoon",
      },
    ]);

    const followUpClaim = await claimFollowUpInThread({
      fixture: teams.fixture,
      runnerGroup: teams.runnerGroup,
      threadId: "root-teams-api-error",
      activityId: "activity-teams-api-error-follow-up",
    });
    expect(followUpClaim.resumeSession?.sessionId).toBe(cliAgentSessionId);
  });
});
