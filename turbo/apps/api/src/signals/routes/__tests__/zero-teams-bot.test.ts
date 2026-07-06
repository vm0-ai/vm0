import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";

import { zeroTeamsConnectContract } from "@vm0/api-contracts/contracts/zero-teams-connect";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { zeroTeamsBotRoutes } from "../zero-teams-bot";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";
import {
  removeTeamsForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  type TeamsConnectFixture,
} from "./helpers/zero-teams-connect";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const authOrgApi = createAuthOrgAgentsBddApi(context);
const runsApi = createRunsAutomationsApi(context);
const trackTeamsFixture = createFixtureTracker<TeamsConnectFixture>(
  async (fixture) => {
    await removeTeamsForTest(context.signal, fixture);
  },
);
const TEAMS_BOT_PATH = "http://api.test/api/zero/teams/bot";
const BOT_APP_ID = "00000000-0000-0000-0000-000000000001";
const BOT_APP_PASSWORD = "teams-test-password";
const TEAMS_APP_TENANT_ID = "11111111-1111-1111-1111-111111111111";
const SERVICE_URL = "https://smba.trafficmanager.net/amer/";
const APP_ORIGIN = "https://app.vm0.test";
const KEY_ID = "teams-test-key";
const BOT_FRAMEWORK_TOKEN_URL =
  "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";
const BOT_FRAMEWORK_METADATA_URL =
  "https://login.botframework.com/v1/.well-known/openidconfiguration";
const BOT_FRAMEWORK_KEYS_URL =
  "https://login.botframework.com/v1/.well-known/keys";

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = keyPair.publicKey.export({ format: "jwk" });

function botFixture(): TeamsConnectFixture {
  return teamsConnectFixture({
    orgId: "org_teams_bot_test",
    userId: "user_teams_bot_test",
    teamsTenantId: "tenant-1",
    teamsTenantName: "Tenant One",
    teamsTeamId: "team-1",
    teamsTeamName: "Team One",
    teamsUserId: "29:user-1",
    serviceUrl: SERVICE_URL,
  });
}

function teamsInstallUrl(): string {
  const url = new URL(`https://teams.microsoft.com/l/app/${BOT_APP_ID}`);
  url.searchParams.set("installAppPackage", "true");
  url.searchParams.set("appTenantId", TEAMS_APP_TENANT_ID);
  return url.toString();
}

function botFrameworkHandlers(): void {
  server.use(
    http.get(BOT_FRAMEWORK_METADATA_URL, () => {
      return HttpResponse.json({
        issuer: "https://api.botframework.com",
        jwks_uri: BOT_FRAMEWORK_KEYS_URL,
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }),
    http.get(BOT_FRAMEWORK_KEYS_URL, () => {
      return HttpResponse.json({
        keys: [
          {
            ...publicJwk,
            kid: KEY_ID,
            use: "sig",
            alg: "RS256",
            endorsements: ["msteams"],
          },
        ],
      });
    }),
  );
}

function teamsServiceBaseUrl(serviceUrl: string): string {
  return serviceUrl.replace(/\/+$/u, "");
}

function teamsOutboundHandlers(serviceUrl: string): void {
  const serviceBaseUrl = teamsServiceBaseUrl(serviceUrl);
  server.use(
    http.post(BOT_FRAMEWORK_TOKEN_URL, () => {
      return HttpResponse.json({
        access_token: "teams-access-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }),
    http.post(
      `${serviceBaseUrl}/v3/conversations/:conversationId/activities`,
      () => {
        return HttpResponse.json({ id: "teams-activity-1" });
      },
    ),
    http.post(
      `${serviceBaseUrl}/v3/conversations/:conversationId/activities/:activityId`,
      () => {
        return HttpResponse.json({ id: "teams-activity-1" });
      },
    ),
  );
}

interface TeamsGraphMessageFixture {
  readonly id: string;
  readonly text: string;
  readonly createdDateTime: string;
  readonly senderId?: string;
  readonly senderName?: string;
}

function graphTokenUrl(tenantId: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(
    tenantId,
  )}/oauth2/v2.0/token`;
}

function teamsGraphMessage(
  message: TeamsGraphMessageFixture,
): Record<string, unknown> {
  return {
    id: message.id,
    createdDateTime: message.createdDateTime,
    messageType: "message",
    from: {
      user: {
        id: message.senderId ?? "29:user-1",
        displayName: message.senderName ?? "Ada Lovelace",
      },
    },
    body: {
      contentType: "html",
      content: `<p>${message.text}</p>`,
    },
  };
}

function teamsGraphHistoryHandlers(args: {
  readonly tenantId: string;
  readonly channelMessages: readonly TeamsGraphMessageFixture[];
  readonly threadRoots: Readonly<Record<string, TeamsGraphMessageFixture>>;
  readonly threadReplies: Readonly<
    Record<string, readonly TeamsGraphMessageFixture[]>
  >;
}): string[] {
  const requests: string[] = [];
  server.use(
    http.post(graphTokenUrl(args.tenantId), async ({ request }) => {
      const form = await request.formData();
      expect(form.get("client_id")).toBe(BOT_APP_ID);
      expect(form.get("client_secret")).toBe(BOT_APP_PASSWORD);
      expect(form.get("scope")).toBe("https://graph.microsoft.com/.default");
      requests.push("graph-token");
      return HttpResponse.json({
        access_token: "teams-graph-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }),
    http.get(
      "https://graph.microsoft.com/v1.0/teams/:teamId/channels/:channelId/messages",
      ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer teams-graph-token",
        );
        requests.push("channel-messages");
        return HttpResponse.json({
          value: args.channelMessages.map(teamsGraphMessage),
        });
      },
    ),
    http.get(
      "https://graph.microsoft.com/v1.0/teams/:teamId/channels/:channelId/messages/:messageId/replies",
      ({ params, request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer teams-graph-token",
        );
        const messageId =
          typeof params.messageId === "string" ? params.messageId : "";
        requests.push(`thread-replies:${messageId}`);
        return HttpResponse.json({
          value: (args.threadReplies[messageId] ?? []).map(teamsGraphMessage),
        });
      },
    ),
    http.get(
      "https://graph.microsoft.com/v1.0/teams/:teamId/channels/:channelId/messages/:messageId",
      ({ params, request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer teams-graph-token",
        );
        const messageId =
          typeof params.messageId === "string" ? params.messageId : "";
        requests.push(`thread-root:${messageId}`);
        const root = args.threadRoots[messageId];
        return root
          ? HttpResponse.json(teamsGraphMessage(root))
          : HttpResponse.json(
              { error: { code: "NotFound", message: "Message not found" } },
              { status: 404 },
            );
      },
    ),
  );
  return requests;
}

function encodeJwtPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signJwt(args: {
  readonly payload: Record<string, unknown>;
  readonly privateKey: KeyObject;
}): string {
  const header = encodeJwtPart({
    alg: "RS256",
    typ: "JWT",
    kid: KEY_ID,
  });
  const payload = encodeJwtPart(args.payload);
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(args.privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

function teamsToken(
  overrides: {
    readonly audience?: string | readonly string[];
    readonly serviceUrl?: string;
  } = {},
): string {
  const seconds = Math.floor(now() / 1000);
  return signJwt({
    privateKey: keyPair.privateKey,
    payload: {
      iss: "https://api.botframework.com",
      aud: overrides.audience ?? BOT_APP_ID,
      exp: seconds + 600,
      nbf: seconds - 30,
      serviceurl: overrides.serviceUrl ?? SERVICE_URL,
    },
  });
}

function teamsMessageActivity(
  fixture: TeamsConnectFixture = botFixture(),
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    type: "message",
    id: "activity-1",
    timestamp: "2026-06-30T09:10:00.000Z",
    serviceUrl: fixture.serviceUrl,
    channelId: "msteams",
    conversation: {
      id: "19:thread@thread.tacv2",
      conversationType: "channel",
    },
    channelData: {
      tenant: { id: fixture.teamsTenantId, name: fixture.teamsTenantName },
      team: { id: fixture.teamsTeamId, name: fixture.teamsTeamName },
      channel: { id: "19:channel@thread.tacv2", name: "General" },
      teamsAppId: "teams-app-test",
    },
    from: {
      id: fixture.teamsUserId,
      name: "Ada Lovelace",
      aadObjectId: "aad-user-1",
      userPrincipalName: "ada@example.com",
    },
    recipient: { id: "28:bot-1", name: "Zero" },
    text: "<at>Zero</at> deploy the preview",
    entities: [
      {
        type: "mention",
        text: "<at>Zero</at>",
        mentioned: { id: "28:bot-1", name: "Zero" },
      },
    ],
    replyToId: "root-activity",
    ...overrides,
  };
}

function teamsBotRemovedActivity(
  fixture: TeamsConnectFixture = botFixture(),
): Record<string, unknown> {
  return {
    type: "conversationUpdate",
    id: "activity-remove-1",
    timestamp: "2026-06-30T09:20:00.000Z",
    serviceUrl: fixture.serviceUrl,
    channelId: "msteams",
    conversation: {
      id: "19:thread@thread.tacv2",
      conversationType: "channel",
    },
    channelData: {
      tenant: { id: fixture.teamsTenantId, name: fixture.teamsTenantName },
      team: { id: fixture.teamsTeamId, name: fixture.teamsTeamName },
      channel: { id: "19:channel@thread.tacv2", name: "General" },
      teamsAppId: "teams-app-test",
    },
    recipient: { id: "28:bot-1", name: "Zero" },
    membersRemoved: [{ id: "28:bot-1", name: "Zero" }],
  };
}

async function postTeamsActivity(args: {
  readonly activity: Record<string, unknown>;
  readonly token?: string;
}): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: zeroTeamsBotRoutes,
  });
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (args.token) {
    headers.authorization = `Bearer ${args.token}`;
  }
  return await app.request(TEAMS_BOT_PATH, {
    method: "POST",
    headers,
    body: JSON.stringify(args.activity),
  });
}

function promptSection(
  prompt: string,
  heading: string,
  nextHeading?: string,
): string {
  const startIndex = prompt.indexOf(heading);
  if (startIndex === -1) {
    throw new Error(`Missing prompt section ${heading}`);
  }
  if (!nextHeading) {
    return prompt.slice(startIndex);
  }

  const endIndex = prompt.indexOf(nextHeading, startIndex + heading.length);
  return endIndex === -1
    ? prompt.slice(startIndex)
    : prompt.slice(startIndex, endIndex);
}

async function connectTeamsFixture(
  fixture: TeamsConnectFixture,
): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
  const client = setupApp({ context })(zeroTeamsConnectContract);
  await accept(
    client.connect({
      headers: { authorization: "Bearer clerk-session" },
      body: {
        tenantId: fixture.teamsTenantId,
        teamsUserId: fixture.teamsUserId,
        teamsUserDisplayName: "Ada Lovelace",
        teamsUserPrincipalName: "ada@example.com",
      },
    }),
    [200],
  );
}

function dispatchRunId(dispatch: unknown): string {
  if (typeof dispatch !== "object" || dispatch === null) {
    throw new Error("Expected Teams dispatch object");
  }
  const kind = Reflect.get(dispatch, "kind");
  expect(kind === "accepted" || kind === "queued").toBeTruthy();
  const runId = Reflect.get(dispatch, "runId");
  if (typeof runId !== "string") {
    throw new Error("Expected Teams dispatch run id");
  }
  return runId;
}

describe("POST /api/zero/teams/bot", () => {
  beforeEach(() => {
    setupTeamsConnectTestEnv(APP_ORIGIN);
    mockEnv("MICROSOFT_TEAMS_BOT_APP_PASSWORD", BOT_APP_PASSWORD);
    mockEnv("VM0_WEB_URL", "https://www.vm0.test");
    mockEnv("VM0_API_URL", "https://api.vm0.test");
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    context.mocks.axiom.query.mockResolvedValue([]);
  });

  afterEach(async () => {
    await removeTeamsForTest(context.signal, botFixture());
  });

  it("rejects missing Teams authorization", async () => {
    const response = await postTeamsActivity({
      activity: teamsMessageActivity(),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Missing Teams bot bearer token",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("rejects a Teams token for another bot app", async () => {
    botFrameworkHandlers();

    const response = await postTeamsActivity({
      activity: teamsMessageActivity(),
      token: teamsToken({
        audience: "00000000-0000-0000-0000-000000000002",
      }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Invalid Teams bot token audience",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("normalizes a valid Teams message activity", async () => {
    botFrameworkHandlers();

    const response = await postTeamsActivity({
      activity: teamsMessageActivity(),
      token: teamsToken(),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      activity: {
        kind: "message",
        activityId: "activity-1",
        tenantId: "tenant-1",
        serviceUrl: SERVICE_URL,
        conversationId: "19:thread@thread.tacv2",
        conversationType: "channel",
        teamId: "team-1",
        teamName: "Team One",
        channelId: "19:channel@thread.tacv2",
        threadId: "root-activity",
        sender: {
          id: "29:user-1",
          name: "Ada Lovelace",
          aadObjectId: "aad-user-1",
          userPrincipalName: "ada@example.com",
        },
        recipient: {
          id: "28:bot-1",
          name: "Zero",
          aadObjectId: null,
          userPrincipalName: null,
        },
        rawText: "<at>Zero</at> deploy the preview",
        text: "deploy the preview",
        mentionsRecipient: true,
        idempotencyKey: "19:thread@thread.tacv2:message:activity-1",
      },
    });
    expect(body.connectUrl).toContain(`${APP_ORIGIN}/api/zero/teams/connect`);
    expect(body.connectUrl).toContain("tenantId=tenant-1");
    expect(body.connectUrl).toContain("teamsUserId=29%3Auser-1");
    expect(body.dispatch).toMatchObject({
      kind: "notice",
      connectUrl: expect.stringContaining(
        `${APP_ORIGIN}/api/zero/teams/connect`,
      ),
      replyText: expect.stringContaining("Please connect"),
    });

    mocks.clerk.session(
      "user_teams_bot_test",
      "org_teams_bot_test",
      "org:admin",
    );
    const client = setupApp({ context })(zeroTeamsConnectContract);
    await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          tenantId: "tenant-1",
          teamsUserId: "29:user-1",
          teamsUserDisplayName: "Ada Lovelace",
          teamsUserPrincipalName: "ada@example.com",
        },
      }),
      [200],
    );
    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body).toMatchObject({
      isInstalled: true,
      isConnected: true,
      tenantId: "tenant-1",
      tenantName: "Tenant One",
      teamId: "team-1",
      teamName: "Team One",
    });
  });

  it("ignores Teams channel messages that do not mention the bot", async () => {
    botFrameworkHandlers();

    const response = await postTeamsActivity({
      activity: teamsMessageActivity(botFixture(), {
        id: "activity-unmentioned-channel",
        text: "hello channel",
        entities: [],
      }),
      token: teamsToken(),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      activity: {
        kind: "message",
        text: "hello channel",
        mentionsRecipient: false,
      },
      dispatch: { kind: "ignored" },
    });
  });

  it("handles Teams personal messages without requiring a bot mention", async () => {
    botFrameworkHandlers();

    const response = await postTeamsActivity({
      activity: teamsMessageActivity(botFixture(), {
        id: "activity-personal-dm",
        conversation: {
          id: "a:personal-conversation",
          conversationType: "personal",
        },
        channelData: {
          tenant: { id: "tenant-1", name: "Tenant One" },
          teamsAppId: "teams-app-test",
        },
        text: "hello from dm",
        entities: [],
        replyToId: null,
      }),
      token: teamsToken(),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      activity: {
        kind: "message",
        conversationType: "personal",
        threadId: "activity-personal-dm",
        text: "hello from dm",
        mentionsRecipient: false,
      },
      dispatch: {
        kind: "notice",
        replyText: expect.stringContaining("Please connect"),
      },
    });
  });

  it("preserves non-bot Teams mentions in message text", async () => {
    botFrameworkHandlers();

    const response = await postTeamsActivity({
      activity: teamsMessageActivity(botFixture(), {
        id: "activity-user-mention",
        text: "<at>Zero</at> ask <at>Grace Hopper</at> to review",
        entities: [
          {
            type: "mention",
            text: "<at>Zero</at>",
            mentioned: { id: "28:bot-1", name: "Zero" },
          },
          {
            type: "mention",
            text: "<at>Grace Hopper</at>",
            mentioned: { id: "29:user-2", name: "Grace Hopper" },
          },
        ],
      }),
      token: teamsToken(),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      activity: {
        kind: "message",
        text: "ask @Grace Hopper (29:user-2) to review",
        mentionsRecipient: true,
      },
    });
  });

  it("dispatches connected Teams messages to the org default agent", async () => {
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
    const agent = await authOrgApi.createAgent(actor, {
      displayName: "Teams default agent",
      visibility: "public",
    });
    await authOrgApi.setDefaultAgent(actor, agent.agentId);
    await runsApi.grantProEntitlement(actor);
    await runsApi.ensureOrgModelProvider(actor);
    botFrameworkHandlers();

    const installResponse = await postTeamsActivity({
      activity: teamsMessageActivity(fixture),
      token: teamsToken(),
    });
    expect(installResponse.status).toBe(200);
    await connectTeamsFixture(fixture);

    teamsOutboundHandlers(fixture.serviceUrl);
    const channelMessages: TeamsGraphMessageFixture[] = [];
    const threadRoots: Record<string, TeamsGraphMessageFixture> = {
      "root-dispatch": {
        id: "root-dispatch",
        text: "remember the deployment target",
        createdDateTime: "2026-06-30T09:10:00.000Z",
        senderId: fixture.teamsUserId,
      },
    };
    const threadReplies: Record<string, TeamsGraphMessageFixture[]> = {
      "root-dispatch": [
        {
          id: "activity-context-1",
          text: "confirm the target is staging",
          createdDateTime: "2026-06-30T09:11:00.000Z",
          senderId: fixture.teamsUserId,
        },
        {
          id: "activity-dispatch-1",
          text: "ship the Teams dispatch",
          createdDateTime: "2026-06-30T09:12:00.000Z",
          senderId: fixture.teamsUserId,
        },
      ],
    };
    const graphRequests = teamsGraphHistoryHandlers({
      tenantId: fixture.teamsTenantId,
      channelMessages,
      threadRoots,
      threadReplies,
    });

    channelMessages.push(
      {
        id: "activity-channel-context-1",
        text: "start another topic",
        createdDateTime: "2026-06-30T09:12:00.000Z",
        senderId: fixture.teamsUserId,
      },
      {
        id: "channel-prior-1",
        text: "api channel planning",
        createdDateTime: "2026-06-30T09:09:00.000Z",
        senderId: fixture.teamsUserId,
      },
      {
        id: "channel-future-1",
        text: "future channel topic",
        createdDateTime: "2026-06-30T09:13:00.000Z",
        senderId: fixture.teamsUserId,
      },
    );

    const channelContextResponse = await postTeamsActivity({
      activity: teamsMessageActivity(fixture, {
        id: "activity-channel-context-1",
        replyToId: null,
        text: "<at>Zero</at> start another topic",
      }),
      token: teamsToken(),
    });
    expect(channelContextResponse.status).toBe(200);
    const channelContextBody = await channelContextResponse.json();
    const channelContextRunId = dispatchRunId(channelContextBody.dispatch);
    await runsApi.heartbeatRunner(runnerGroup);
    const channelContextClaim =
      await runsApi.claimRunnerJob(channelContextRunId);
    const channelContextAppendSystemPrompt =
      channelContextClaim.appendSystemPrompt ?? "";
    const recentChannelContext = promptSection(
      channelContextAppendSystemPrompt,
      "# Recent Channel Messages",
    );
    expect(channelContextClaim.prompt).toBe("start another topic");
    expect(graphRequests).toContain("channel-messages");
    expect(recentChannelContext).toContain("api channel planning");
    expect(recentChannelContext).not.toContain("start another topic");
    expect(channelContextAppendSystemPrompt).not.toContain(
      "# Microsoft Teams Thread Context",
    );

    channelMessages.splice(
      0,
      channelMessages.length,
      {
        id: "root-dispatch",
        text: "remember the deployment target",
        createdDateTime: "2026-06-30T09:10:00.000Z",
        senderId: fixture.teamsUserId,
      },
      {
        id: "channel-prior-1",
        text: "api channel planning",
        createdDateTime: "2026-06-30T09:09:00.000Z",
        senderId: fixture.teamsUserId,
      },
    );

    const response = await postTeamsActivity({
      activity: teamsMessageActivity(fixture, {
        id: "activity-dispatch-1",
        replyToId: "root-dispatch",
        text: "<at>Zero</at> ship the Teams dispatch",
      }),
      token: teamsToken(),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.dispatch).toMatchObject({
      kind: expect.stringMatching(/^(accepted|queued)$/u),
      runId: expect.any(String),
    });

    const runId = dispatchRunId(body.dispatch);
    await runsApi.heartbeatRunner(runnerGroup);
    const claim = await runsApi.claimRunnerJob(runId);
    const appendSystemPrompt = claim.appendSystemPrompt ?? "";
    const currentUserPrompt = promptSection(
      appendSystemPrompt,
      "# Current User Info",
      "# Current Integration",
    );
    const currentIntegrationPrompt = promptSection(
      appendSystemPrompt,
      "# Current Integration",
      "# Recent Channel Messages",
    );
    const replyRecentChannelContext = promptSection(
      appendSystemPrompt,
      "# Recent Channel Messages",
      "# Microsoft Teams Thread Context",
    );
    const teamsThreadContext = promptSection(
      appendSystemPrompt,
      "# Microsoft Teams Thread Context",
    );
    expect(claim.prompt).toBe("ship the Teams dispatch");
    expect(currentIntegrationPrompt).toContain(
      "You are currently running inside: Microsoft Teams",
    );
    expect(appendSystemPrompt).toContain("Microsoft Teams messaging and files");
    expect(currentIntegrationPrompt).toContain(
      `Tenant ID: ${fixture.teamsTenantId}`,
    );
    expect(currentIntegrationPrompt).toContain(
      `Team ID: ${fixture.teamsTeamId}`,
    );
    expect(currentIntegrationPrompt).toContain(
      "Conversation ID: 19:thread@thread.tacv2",
    );
    expect(currentIntegrationPrompt).toContain("Thread ID: root-dispatch");
    expect(currentIntegrationPrompt).not.toContain("Teams user ID:");
    expect(currentIntegrationPrompt).not.toContain("Teams display name:");
    expect(currentIntegrationPrompt).not.toContain(
      "Teams user principal name:",
    );
    expect(replyRecentChannelContext).toContain("api channel planning");
    expect(replyRecentChannelContext).not.toContain(
      "remember the deployment target",
    );
    expect(replyRecentChannelContext).not.toContain("future channel topic");
    expect(currentUserPrompt).toContain(
      `Teams user ID: ${fixture.teamsUserId}`,
    );
    expect(currentUserPrompt).toContain(
      "Teams user principal name: ada@example.com",
    );
    expect(currentUserPrompt).toContain("Teams display name: Ada Lovelace");
    expect(teamsThreadContext).toContain(
      "The messages below are from a Microsoft Teams conversation",
    );
    expect(teamsThreadContext).toContain("- RELATIVE_INDEX: -1");
    expect(teamsThreadContext).toContain(
      `- SENDER: {id: ${fixture.teamsUserId}, name: Ada Lovelace}`,
    );
    expect(teamsThreadContext).toContain("remember the deployment target");
    expect(teamsThreadContext).toContain("confirm the target is staging");
    expect(teamsThreadContext).not.toContain("ship the Teams dispatch");
    expect(graphRequests).toContain("thread-root:root-dispatch");
    expect(graphRequests).toContain("thread-replies:root-dispatch");
  });

  it("asks connected Teams users to configure a default agent", async () => {
    const fixture = await trackTeamsFixture(
      Promise.resolve(teamsConnectFixture()),
    );
    botFrameworkHandlers();

    const installResponse = await postTeamsActivity({
      activity: teamsMessageActivity(fixture),
      token: teamsToken(),
    });
    expect(installResponse.status).toBe(200);
    await connectTeamsFixture(fixture);

    const response = await postTeamsActivity({
      activity: teamsMessageActivity(fixture, {
        id: "activity-no-default",
        text: "<at>Zero</at> hello",
      }),
      token: teamsToken(),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      dispatch: {
        kind: "notice",
        replyText: expect.stringContaining("No agent is configured"),
      },
    });
  });

  it("normalizes a Teams bot removal activity", async () => {
    botFrameworkHandlers();

    const response = await postTeamsActivity({
      activity: teamsBotRemovedActivity(),
      token: teamsToken(),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      activity: {
        kind: "bot_removed",
        reason: "members_removed",
        tenantId: "tenant-1",
        conversationId: "19:thread@thread.tacv2",
        channelId: "19:channel@thread.tacv2",
        membersRemoved: [
          {
            id: "28:bot-1",
            name: "Zero",
            aadObjectId: null,
            userPrincipalName: null,
          },
        ],
        idempotencyKey:
          "19:thread@thread.tacv2:conversationUpdate:activity-remove-1",
      },
    });
  });

  it("cleans up installation and dependent connections on Teams bot removal", async () => {
    const fixture = botFixture();
    botFrameworkHandlers();
    await postTeamsActivity({
      activity: teamsMessageActivity(),
      token: teamsToken(),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context })(zeroTeamsConnectContract);
    await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          tenantId: fixture.teamsTenantId,
          teamsUserId: fixture.teamsUserId,
        },
      }),
      [200],
    );

    const response = await postTeamsActivity({
      activity: teamsBotRemovedActivity(),
      token: teamsToken(),
    });

    expect(response.status).toBe(200);
    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body).toStrictEqual({
      isInstalled: false,
      isConnected: false,
      isAdmin: true,
      installUrl: teamsInstallUrl(),
    });
  });
});
