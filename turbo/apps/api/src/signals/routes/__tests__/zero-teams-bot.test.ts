import {
  createHmac,
  createSign,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
} from "node:crypto";

import { zeroTeamsConnectContract } from "@vm0/api-contracts/contracts/zero-teams-connect";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { signSandboxJwtForTests, verifyZeroToken } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearTeamsBotAuthCacheForTest } from "../../../lib/teams-bot-auth";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { ROUTES } from "../../route";
import { zeroTeamsBotRoutes } from "../zero-teams-bot";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createUserConfigBddApi } from "./helpers/api-bdd-user-config";
import {
  installTeamsForTest,
  removeTeamsForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  type TeamsConnectFixture,
} from "./helpers/zero-teams-connect";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const authOrgApi = createAuthOrgAgentsBddApi(context);
const computerUseApi = createComputerUseBddApi(context);
const runsApi = createRunsApi(context);
const userConfigApi = createUserConfigBddApi(context);
const trackTeamsFixture = createFixtureTracker<TeamsConnectFixture>(
  async (fixture) => {
    await removeTeamsForTest(context.signal, fixture);
  },
);
const TEAMS_BOT_PATH = "http://api.test/api/zero/teams/bot";
const BOT_APP_ID = "00000000-0000-0000-0000-000000000001";
const BOT_APP_PASSWORD = "teams-test-password";
const TEAMS_APP_TENANT_ID = "11111111-1111-1111-1111-111111111111";
const TEAMS_AAD_GROUP_ID = "22222222-2222-2222-2222-222222222222";
const SERVICE_URL = "https://smba.trafficmanager.net/amer/";
const APP_ORIGIN = "https://app.vm0.test";
const KEY_ID = "teams-test-key";
const TEAMS_LOGIN_PROMPT_FALLBACK_TEXT =
  "Please connect your account to use Okou in this Teams workspace.";
const TEAMS_LOGIN_PROMPT_CARD_TEXT =
  "Please connect your account to use Okou in this Teams workspace.";
const TEAMS_WELCOME_TEXT = [
  "Hi, I'm Okou. I connect Teams conversations to AI agents for research, triage, reports, engineering work, operations, and support.",
  "",
  "To get started, use `connect` to link this Teams workspace to Okou. An org admin may need to complete workspace setup first.",
  "",
  "Commands: `help`, `connect`, `disconnect`, `switch`, `model`. Mention `@Okou` with a task or send a DM to work privately.",
].join("\n");
const BOT_FRAMEWORK_METADATA_URL =
  "https://login.botframework.com/v1/.well-known/openidconfiguration";
const BOT_FRAMEWORK_KEYS_URL =
  "https://login.botframework.com/v1/.well-known/keys";
const BOT_FRAMEWORK_TOKEN_URL = `https://login.microsoftonline.com/${TEAMS_APP_TENANT_ID}/oauth2/v2.0/token`;

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
    teamsAadObjectId: "aad-user-1",
    serviceUrl: SERVICE_URL,
  });
}

function teamsInstallUrl(): string {
  const url = new URL(`https://teams.microsoft.com/l/app/${BOT_APP_ID}`);
  url.searchParams.set("installAppPackage", "true");
  url.searchParams.set("appTenantId", TEAMS_APP_TENANT_ID);
  return url.toString();
}

function teamsOauthConnectUrl(fixture: TeamsConnectFixture): string {
  const url = new URL("https://api.vm0.test/api/zero/teams/oauth/connect");
  url.searchParams.set("orgId", fixture.orgId);
  url.searchParams.set("vm0UserId", fixture.userId);
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

interface TeamsOutboundRequest {
  readonly conversationId: string;
  readonly activityId: string | null;
  readonly body: unknown;
}

interface TeamsReactionRequest {
  readonly method: "PUT" | "DELETE";
  readonly conversationId: string;
  readonly activityId: string;
  readonly reactionType: string;
}

type TeamsOutboundRequests = TeamsOutboundRequest[] & {
  readonly reactions: TeamsReactionRequest[];
};

function teamsOutboundHandlers(serviceUrl: string): TeamsOutboundRequests {
  const serviceBaseUrl = teamsServiceBaseUrl(serviceUrl);
  const requests: TeamsOutboundRequests = Object.assign(
    [] as TeamsOutboundRequest[],
    { reactions: [] as TeamsReactionRequest[] },
  );
  server.use(
    http.post(BOT_FRAMEWORK_TOKEN_URL, async ({ request }) => {
      const form = await request.formData();
      expect(form.get("client_id")).toBe(BOT_APP_ID);
      expect(form.get("client_secret")).toBe(BOT_APP_PASSWORD);
      expect(form.get("scope")).toBe("https://api.botframework.com/.default");
      return HttpResponse.json({
        access_token: "teams-access-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }),
    http.post(
      `${serviceBaseUrl}/v3/conversations/:conversationId/activities`,
      async ({ params, request }) => {
        requests.push({
          conversationId:
            typeof params.conversationId === "string"
              ? params.conversationId
              : "",
          activityId: null,
          body: await request.json(),
        });
        return HttpResponse.json({ id: "teams-activity-1" });
      },
    ),
    http.post(
      `${serviceBaseUrl}/v3/conversations/:conversationId/activities/:activityId`,
      async ({ params, request }) => {
        requests.push({
          conversationId:
            typeof params.conversationId === "string"
              ? params.conversationId
              : "",
          activityId:
            typeof params.activityId === "string" ? params.activityId : "",
          body: await request.json(),
        });
        return HttpResponse.json({ id: "teams-activity-1" });
      },
    ),
    http.put(
      `${serviceBaseUrl}/v3/conversations/:conversationId/activities/:activityId/reactions/:reactionType`,
      ({ params }) => {
        requests.reactions.push({
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
        return new HttpResponse(null, { status: 200 });
      },
    ),
    http.delete(
      `${serviceBaseUrl}/v3/conversations/:conversationId/activities/:activityId/reactions/:reactionType`,
      ({ params }) => {
        requests.reactions.push({
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
        return new HttpResponse(null, { status: 200 });
      },
    ),
  );
  return requests;
}

interface TeamsGraphMessageFixture {
  readonly id: string;
  readonly replyToId?: string | null;
  readonly text: string;
  readonly createdDateTime: string;
  readonly senderId?: string;
  readonly senderName?: string;
  readonly senderPrincipalName?: string | null;
  readonly graphUserPrincipalName?: string | null;
  readonly attachments?: readonly Record<string, unknown>[];
  readonly mentions?: readonly Record<string, unknown>[];
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
    replyToId: message.replyToId ?? null,
    createdDateTime: message.createdDateTime,
    messageType: "message",
    from: {
      user: {
        id: message.senderId ?? "29:user-1",
        displayName: message.senderName ?? "Ada Lovelace",
        ...(message.senderPrincipalName !== undefined
          ? { userPrincipalName: message.senderPrincipalName }
          : {}),
      },
    },
    body: {
      contentType: "html",
      content: `<p>${message.text}</p>`,
    },
    ...(message.attachments ? { attachments: message.attachments } : {}),
    ...(message.mentions ? { mentions: message.mentions } : {}),
  };
}

function teamsGraphUserMap(
  messages: readonly TeamsGraphMessageFixture[],
): ReadonlyMap<
  string,
  {
    readonly displayName: string;
    readonly userPrincipalName: string | null;
  }
> {
  const users = new Map<
    string,
    {
      readonly displayName: string;
      readonly userPrincipalName: string | null;
    }
  >();
  for (const message of messages) {
    const senderId = message.senderId ?? "29:user-1";
    const existing = users.get(senderId);
    const userPrincipalName =
      message.graphUserPrincipalName ?? existing?.userPrincipalName ?? null;
    users.set(senderId, {
      displayName:
        message.senderName ?? existing?.displayName ?? "Ada Lovelace",
      userPrincipalName,
    });
  }
  return users;
}

function teamsGraphHistoryHandlers(args: {
  readonly tenantId: string;
  readonly teamsAppId?: string;
  readonly personalChatId?: string;
  readonly chatMessages?: readonly TeamsGraphMessageFixture[];
  readonly channelMessages: readonly TeamsGraphMessageFixture[];
  readonly threadRoots: Readonly<Record<string, TeamsGraphMessageFixture>>;
  readonly threadReplies: Readonly<
    Record<string, readonly TeamsGraphMessageFixture[]>
  >;
}): string[] {
  const requests: string[] = [];
  const personalChatId =
    args.personalChatId ?? "19:personal-chat@unq.gbl.spaces";
  const personalInstallationId = "personal-app-installation";
  const teamsAppId = args.teamsAppId ?? "teams-app-test";
  const users = teamsGraphUserMap([
    ...(args.chatMessages ?? []),
    ...args.channelMessages,
    ...Object.values(args.threadRoots),
    ...Object.values(args.threadReplies).flat(),
  ]);
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
      "https://graph.microsoft.com/v1.0/users/:userId/teamwork/installedApps",
      ({ params, request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer teams-graph-token",
        );
        const url = new URL(request.url);
        expect(url.searchParams.get("$filter")).toBe(
          `teamsApp/externalId eq '${teamsAppId}'`,
        );
        expect(url.searchParams.get("$expand")).toBe("teamsApp");
        const userId = typeof params.userId === "string" ? params.userId : "";
        requests.push(`personal-installed-apps:${userId}`);
        return HttpResponse.json({
          value: args.chatMessages
            ? [
                {
                  id: personalInstallationId,
                  teamsApp: { externalId: teamsAppId },
                },
              ]
            : [],
        });
      },
    ),
    http.get(
      "https://graph.microsoft.com/v1.0/users/:userId/teamwork/installedApps/:installationId/chat",
      ({ params, request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer teams-graph-token",
        );
        expect(params.installationId).toBe(personalInstallationId);
        const userId = typeof params.userId === "string" ? params.userId : "";
        requests.push(`personal-app-chat:${userId}`);
        return HttpResponse.json({
          id: personalChatId,
          chatType: "oneOnOne",
        });
      },
    ),
    http.get(
      "https://graph.microsoft.com/v1.0/chats/:chatId/messages",
      ({ params, request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer teams-graph-token",
        );
        expect(request.url).toContain("%24top=50");
        expect(request.url).toContain("%24orderby=createdDateTime+desc");
        const chatId = typeof params.chatId === "string" ? params.chatId : "";
        expect(chatId).toBe(personalChatId);
        requests.push(`chat-messages:${chatId}`);
        return HttpResponse.json({
          value: (args.chatMessages ?? []).map(teamsGraphMessage),
        });
      },
    ),
    http.get(
      "https://graph.microsoft.com/v1.0/teams/:teamId/channels/:channelId/messages",
      ({ params, request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer teams-graph-token",
        );
        expect(params.teamId).toBe(TEAMS_AAD_GROUP_ID);
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
        expect(params.teamId).toBe(TEAMS_AAD_GROUP_ID);
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
        expect(params.teamId).toBe(TEAMS_AAD_GROUP_ID);
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
    http.get("https://graph.microsoft.com/v1.0/users/:userId", ({ params }) => {
      const userId = typeof params.userId === "string" ? params.userId : "";
      const user = users.get(userId);
      requests.push(`user:${userId}`);
      return user
        ? HttpResponse.json({
            id: userId,
            displayName: user.displayName,
            userPrincipalName: user.userPrincipalName,
          })
        : HttpResponse.json(
            { error: { code: "NotFound", message: "User not found" } },
            { status: 404 },
          );
    }),
  );
  return requests;
}

function encodeJwtPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function legacyTeamsFileId(payload: Readonly<Record<string, unknown>>): string {
  const encodedPayload = encodeJwtPart(payload);
  const signature = createHmac("sha256", "a".repeat(64))
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
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

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId?: string;
  readonly capabilities?: readonly string[];
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId ?? `run_${randomUUID()}`,
    capabilities: (args.capabilities ?? ["teams:write"]) as never,
    iat: seconds,
    exp: seconds + 60,
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
      team: {
        id: fixture.teamsTeamId,
        aadGroupId: TEAMS_AAD_GROUP_ID,
        name: fixture.teamsTeamName,
      },
      channel: { id: "19:channel@thread.tacv2", name: "General" },
      teamsAppId: "teams-app-test",
    },
    from: {
      id: fixture.teamsUserId,
      name: "Ada Lovelace",
      aadObjectId: fixture.teamsAadObjectId,
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

function teamsBotInstalledActivity(
  fixture: TeamsConnectFixture = botFixture(),
): Record<string, unknown> {
  return {
    type: "conversationUpdate",
    id: "activity-install-1",
    timestamp: "2026-06-30T09:15:00.000Z",
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
      aadObjectId: fixture.teamsAadObjectId,
      userPrincipalName: "ada@example.com",
    },
    recipient: { id: "28:bot-1", name: "Zero" },
    membersAdded: [{ id: "28:bot-1", name: "Zero" }],
  };
}

function teamsBotInstallationAddedActivity(
  fixture: TeamsConnectFixture = botFixture(),
): Record<string, unknown> {
  return {
    type: "installationUpdate",
    action: "add",
    id: "activity-installation-add-1",
    timestamp: "2026-06-30T09:15:00.000Z",
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
      aadObjectId: fixture.teamsAadObjectId,
      userPrincipalName: "ada@example.com",
    },
    recipient: { id: "28:bot-1", name: "Zero" },
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

async function readTeamsBotResponseAndFlush(
  response: Response,
): Promise<unknown> {
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  await flushWaitUntilForTest();
  return body;
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

function requestTokenFromUrl(authorizationUrl: string): string {
  const url = new URL(authorizationUrl);
  const prefix = "/computer-use/authorize/";
  if (!url.pathname.startsWith(prefix)) {
    throw new Error(`Unexpected authorization URL: ${authorizationUrl}`);
  }
  return decodeURIComponent(url.pathname.slice(prefix.length));
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
        teamsAadObjectId: fixture.teamsAadObjectId,
        teamsUserDisplayName: "Ada Lovelace",
        teamsUserPrincipalName: "ada@example.com",
      },
    }),
    [200],
  );
}

function teamsPersonalMessageActivity(args: {
  readonly fixture: TeamsConnectFixture;
  readonly id: string;
  readonly text: string;
  readonly value?: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  return teamsMessageActivity(args.fixture, {
    id: args.id,
    conversation: {
      id: `a:personal-${args.fixture.teamsUserId}`,
      conversationType: "personal",
    },
    channelData: {
      tenant: {
        id: args.fixture.teamsTenantId,
        name: args.fixture.teamsTenantName,
      },
      teamsAppId: "teams-app-test",
    },
    text: args.text,
    entities: [],
    ...(args.value ? { value: args.value } : {}),
    replyToId: null,
  });
}

function teamsPersonalThreadMessageActivity(args: {
  readonly fixture: TeamsConnectFixture;
  readonly id: string;
  readonly threadId: string;
  readonly text: string;
}): Record<string, unknown> {
  return teamsMessageActivity(args.fixture, {
    id: args.id,
    conversation: {
      id: `a:personal-${args.fixture.teamsUserId}`,
      conversationType: "personal",
    },
    channelData: {
      tenant: {
        id: args.fixture.teamsTenantId,
        name: args.fixture.teamsTenantName,
      },
      teamsAppId: "teams-app-test",
    },
    text: args.text,
    entities: [],
    replyToId: args.threadId,
  });
}

async function setupConnectedTeamsBotActor(): Promise<{
  readonly fixture: TeamsConnectFixture;
  readonly actor: ReturnType<typeof authOrgApi.user>;
  readonly runnerGroup: string;
  readonly outboundRequests: TeamsOutboundRequests;
}> {
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
  const defaultAgent = await authOrgApi.bootstrapOnboarding(actor, {
    displayName: "Teams default agent",
  });
  await authOrgApi.updateAgentMetadata(actor, defaultAgent.body.agentId, {
    visibility: "public",
  });
  await runsApi.grantProEntitlement(actor);
  await runsApi.ensureOrgModelProvider(actor);
  botFrameworkHandlers();
  const outboundRequests = teamsOutboundHandlers(fixture.serviceUrl);

  const installResponse = await postTeamsActivity({
    activity: teamsMessageActivity(fixture),
    token: teamsToken(),
  });
  expect(installResponse.status).toBe(200);
  await installResponse.json();
  await flushWaitUntilForTest();
  await connectTeamsFixture(fixture);

  return { fixture, actor, runnerGroup, outboundRequests };
}

describe("POST /api/zero/teams/bot", () => {
  beforeEach(() => {
    setupTeamsConnectTestEnv(APP_ORIGIN);
    mockEnv("MICROSOFT_TEAMS_BOT_APP_PASSWORD", BOT_APP_PASSWORD);
    mockEnv("SECRETS_ENCRYPTION_KEY", "a".repeat(64));
    mockEnv("VM0_WEB_URL", "https://www.vm0.test");
    mockEnv("VM0_API_BACKEND_URL", "https://api.vm0.test");
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    context.mocks.axiom.query.mockResolvedValue([]);
    teamsOutboundHandlers(SERVICE_URL);
  });

  afterEach(async () => {
    await flushWaitUntilForTest();
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

  it("rejects a Teams activity without a stable identifier", async () => {
    const response = await postTeamsActivity({
      activity: teamsMessageActivity(botFixture(), {
        id: undefined,
        timestamp: undefined,
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Missing Teams activity id or timestamp",
        code: "BAD_REQUEST",
      },
    });
  });

  it("rejects a Teams message without an activity id", async () => {
    const response = await postTeamsActivity({
      activity: teamsMessageActivity(botFixture(), { id: undefined }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Missing Teams message activity id",
        code: "BAD_REQUEST",
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
    const outboundRequests = teamsOutboundHandlers(SERVICE_URL);

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
        teamAadGroupId: TEAMS_AAD_GROUP_ID,
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
    expect(body.connectUrl).toContain(`${APP_ORIGIN}/settings/teams`);
    const connectUrl = new URL(String(body.connectUrl));
    expect(connectUrl.searchParams.get("tenantId")).toBe("tenant-1");
    expect(connectUrl.searchParams.get("tenantName")).toBe("Tenant One");
    expect(connectUrl.searchParams.get("teamsUserId")).toBe("29:user-1");
    expect(connectUrl.searchParams.get("teamsAadObjectId")).toBe("aad-user-1");
    expect(connectUrl.searchParams.get("activityId")).toBe("activity-1");
    expect(connectUrl.searchParams.get("teamsUserDisplayName")).toBe(
      "Ada Lovelace",
    );
    expect(connectUrl.searchParams.get("teamsUserPrincipalName")).toBe(
      "ada@example.com",
    );
    expect(connectUrl.searchParams.get("displayName")).toBeNull();
    expect(connectUrl.searchParams.get("upn")).toBeNull();
    expect(connectUrl.searchParams.get("teamId")).toBe("team-1");
    expect(connectUrl.searchParams.get("teamName")).toBe("Team One");
    expect(connectUrl.searchParams.get("conversationType")).toBe("channel");
    expect(body).not.toHaveProperty("dispatch");
    await flushWaitUntilForTest();
    expect(outboundRequests).toHaveLength(1);
    expect(outboundRequests[0]).toMatchObject({
      conversationId: "19:thread@thread.tacv2",
      activityId: "activity-1",
      body: {
        type: "message",
        summary: TEAMS_LOGIN_PROMPT_FALLBACK_TEXT,
        replyToId: "activity-1",
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: {
              type: "AdaptiveCard",
              version: "1.4",
              body: [
                {
                  type: "TextBlock",
                  text: TEAMS_LOGIN_PROMPT_CARD_TEXT,
                  wrap: true,
                },
              ],
              actions: [
                {
                  type: "Action.OpenUrl",
                  title: "Connect",
                  url: expect.stringContaining(`${APP_ORIGIN}/settings/teams`),
                },
              ],
            },
          },
        ],
        channelData: {
          tenant: { id: "tenant-1" },
        },
      },
    });
    expect(outboundRequests[0]?.body).not.toHaveProperty("text");

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
          teamsAadObjectId: "aad-user-1",
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
    const body = await response.json();
    expect(body).toMatchObject({
      activity: {
        kind: "message",
        text: "hello channel",
        mentionsRecipient: false,
      },
    });
    expect(body).not.toHaveProperty("dispatch");
    await flushWaitUntilForTest();
  });

  it("sends one team welcome across installation and members-added events", async () => {
    botFrameworkHandlers();
    const outboundRequests = teamsOutboundHandlers(SERVICE_URL);

    const installationResponse = await postTeamsActivity({
      activity: teamsBotInstallationAddedActivity(),
      token: teamsToken(),
    });
    const membersAddedResponse = await postTeamsActivity({
      activity: teamsBotInstalledActivity(),
      token: teamsToken(),
    });

    expect(installationResponse.status).toBe(200);
    expect(membersAddedResponse.status).toBe(200);
    await installationResponse.json();
    await membersAddedResponse.json();
    await flushWaitUntilForTest();
    expect(outboundRequests).toHaveLength(1);
    expect(outboundRequests[0]).toMatchObject({
      conversationId: "19:thread@thread.tacv2",
      activityId: null,
      body: {
        type: "message",
        text: expect.stringContaining(
          "<at>Ada Lovelace</at> added Okou to this Teams workspace.",
        ),
        textFormat: "markdown",
        entities: [
          {
            type: "mention",
            text: "<at>Ada Lovelace</at>",
            mentioned: {
              id: "29:user-1",
              name: "Ada Lovelace",
            },
          },
        ],
        channelData: {
          tenant: { id: "tenant-1" },
        },
      },
    });
    expect(outboundRequests[0]?.body).not.toHaveProperty("replyToId");
  });

  it("sends a personal welcome message when Teams adds the bot in personal scope", async () => {
    botFrameworkHandlers();
    const outboundRequests = teamsOutboundHandlers(SERVICE_URL);

    const response = await postTeamsActivity({
      activity: {
        ...teamsBotInstallationAddedActivity(),
        id: "activity-install-personal",
        conversation: {
          id: "a:personal-29:user-1",
          conversationType: "personal",
        },
        channelData: {
          tenant: { id: "tenant-1", name: "Tenant One" },
          teamsAppId: "teams-app-test",
        },
      },
      token: teamsToken(),
    });

    expect(response.status).toBe(200);
    await response.json();
    await flushWaitUntilForTest();
    expect(outboundRequests).toHaveLength(1);
    expect(outboundRequests[0]).toMatchObject({
      conversationId: "a:personal-29:user-1",
      activityId: null,
      body: {
        type: "message",
        text: TEAMS_WELCOME_TEXT,
        textFormat: "markdown",
        channelData: {
          tenant: { id: "tenant-1" },
        },
      },
    });
    expect(outboundRequests[0]?.body).not.toHaveProperty("entities");
    expect(outboundRequests[0]?.body).not.toHaveProperty("replyToId");
  });

  it("responds to Teams validation help and greeting messages without a mention", async () => {
    botFrameworkHandlers();
    const outboundRequests = teamsOutboundHandlers(SERVICE_URL);

    const helpResponse = await postTeamsActivity({
      activity: teamsMessageActivity(botFixture(), {
        id: "activity-validation-help",
        text: "help",
        entities: [],
      }),
      token: teamsToken(),
    });
    const helpBody = await readTeamsBotResponseAndFlush(helpResponse);
    expect(helpBody).not.toHaveProperty("dispatch");

    const slashHelpResponse = await postTeamsActivity({
      activity: teamsMessageActivity(botFixture(), {
        id: "activity-validation-slash-help",
        text: "/help",
        entities: [],
      }),
      token: teamsToken(),
    });
    const slashHelpBody = await readTeamsBotResponseAndFlush(slashHelpResponse);
    expect(slashHelpBody).not.toHaveProperty("dispatch");

    const groupChatHelpResponse = await postTeamsActivity({
      activity: teamsMessageActivity(botFixture(), {
        id: "activity-validation-group-chat-help",
        conversation: {
          id: "19:group-chat@thread.v2",
          conversationType: "groupChat",
        },
        channelData: {
          tenant: { id: "tenant-1", name: "Tenant One" },
          teamsAppId: "teams-app-test",
        },
        text: "help",
        entities: [],
        replyToId: null,
      }),
      token: teamsToken(),
    });
    const groupChatHelpBody = await readTeamsBotResponseAndFlush(
      groupChatHelpResponse,
    );
    expect(groupChatHelpBody).not.toHaveProperty("dispatch");

    const greetingResponse = await postTeamsActivity({
      activity: teamsMessageActivity(botFixture(), {
        id: "activity-validation-hi",
        text: "Hi",
        entities: [],
      }),
      token: teamsToken(),
    });
    const greetingBody = await readTeamsBotResponseAndFlush(greetingResponse);
    expect(greetingBody).not.toHaveProperty("dispatch");
    expect(outboundRequests).toHaveLength(4);
    expect(
      outboundRequests.map((request) => {
        return request.activityId;
      }),
    ).toStrictEqual([
      "activity-validation-help",
      "activity-validation-slash-help",
      "activity-validation-group-chat-help",
      "activity-validation-hi",
    ]);
    expect(outboundRequests[0]?.body).toMatchObject({
      text: expect.stringContaining("Okou Teams Bot Help"),
    });
    expect(outboundRequests[2]?.body).toMatchObject({
      text: expect.stringContaining("Okou Teams Bot Help"),
    });
    expect(outboundRequests[3]?.body).toMatchObject({
      text: TEAMS_WELCOME_TEXT,
    });
  });

  it("responds to Teams greeting messages with a mention", async () => {
    botFrameworkHandlers();
    const outboundRequests = teamsOutboundHandlers(SERVICE_URL);

    const response = await postTeamsActivity({
      activity: teamsMessageActivity(botFixture(), {
        id: "activity-mentioned-hi",
        text: "<at>Zero</at> Hi",
      }),
      token: teamsToken(),
    });

    const body = await readTeamsBotResponseAndFlush(response);
    expect(body).toMatchObject({
      activity: {
        kind: "message",
        text: "Hi",
        mentionsRecipient: true,
      },
    });
    expect(outboundRequests).toHaveLength(1);
    expect(outboundRequests[0]).toMatchObject({
      conversationId: "19:thread@thread.tacv2",
      activityId: "activity-mentioned-hi",
      body: {
        type: "message",
        text: TEAMS_WELCOME_TEXT,
        replyToId: "activity-mentioned-hi",
      },
    });
  });

  it("does not run other Teams commands without a mention in channel scope", async () => {
    botFrameworkHandlers();
    const outboundRequests = teamsOutboundHandlers(SERVICE_URL);

    const response = await postTeamsActivity({
      activity: teamsMessageActivity(botFixture(), {
        id: "activity-unmentioned-disconnect",
        text: "disconnect",
        entities: [],
      }),
      token: teamsToken(),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      activity: {
        kind: "message",
        text: "disconnect",
        mentionsRecipient: false,
      },
    });
    expect(body).not.toHaveProperty("dispatch");
    await flushWaitUntilForTest();
    expect(outboundRequests).toHaveLength(0);
  });

  it("handles Teams personal messages without requiring a bot mention", async () => {
    botFrameworkHandlers();
    const outboundRequests = teamsOutboundHandlers(SERVICE_URL);

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
    const body = await response.json();
    expect(body).toMatchObject({
      activity: {
        kind: "message",
        conversationType: "personal",
        threadId: "activity-personal-dm",
        text: "hello from dm",
        mentionsRecipient: false,
      },
    });
    expect(body).not.toHaveProperty("dispatch");
    await flushWaitUntilForTest();
    expect(outboundRequests).toHaveLength(1);
    expect(outboundRequests[0]).toMatchObject({
      conversationId: "a:personal-conversation",
      activityId: "activity-personal-dm",
      body: {
        type: "message",
        summary: TEAMS_LOGIN_PROMPT_FALLBACK_TEXT,
        replyToId: "activity-personal-dm",
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: {
              type: "AdaptiveCard",
              version: "1.4",
              body: [
                {
                  type: "TextBlock",
                  text: TEAMS_LOGIN_PROMPT_CARD_TEXT,
                  wrap: true,
                },
              ],
              actions: [
                {
                  type: "Action.OpenUrl",
                  title: "Connect",
                  url: expect.stringContaining(`${APP_ORIGIN}/settings/teams`),
                },
              ],
            },
          },
        ],
      },
    });
    expect(outboundRequests[0]?.body).not.toHaveProperty("text");
  });

  it("downloads Teams channel reference attachments through Graph", async () => {
    botFrameworkHandlers();
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
    const defaultAgent = await authOrgApi.bootstrapOnboarding(actor, {
      displayName: "Teams file agent",
    });
    await authOrgApi.updateAgentMetadata(actor, defaultAgent.body.agentId, {
      visibility: "public",
    });
    await runsApi.grantProEntitlement(actor);
    await runsApi.ensureOrgModelProvider(actor);
    await installTeamsForTest(context.signal, fixture);
    await connectTeamsFixture(fixture);
    clearTeamsBotAuthCacheForTest();
    botFrameworkHandlers();
    teamsOutboundHandlers(fixture.serviceUrl);
    teamsGraphHistoryHandlers({
      tenantId: fixture.teamsTenantId,
      channelMessages: [],
      threadRoots: {},
      threadReplies: {},
    });

    const contentUrl = "https://contoso.sharepoint.com/sites/docs/spec.png";
    const response = await postTeamsActivity({
      activity: teamsMessageActivity(fixture, {
        id: "activity-file-channel",
        text: "please inspect this",
        replyToId: null,
        attachments: [
          {
            id: "channel-attachment-1",
            contentType: "reference",
            contentUrl,
            name: "spec.png",
          },
        ],
      }),
      token: teamsToken(),
    });

    expect(response.status).toBe(200);
    const body = await readTeamsBotResponseAndFlush(response);
    expect(body).not.toHaveProperty("dispatch");
    const list = await runsApi.listAgentRuns(actor, { limit: 20 });
    const run = list.runs.find((item) => {
      return (
        item.prompt.includes("please inspect this") &&
        item.prompt.includes("[Teams file] spec.png (image/png)")
      );
    });
    expect(run).toBeDefined();
    const runId = run?.id;
    if (!runId) {
      throw new Error("Expected Teams file run id");
    }
    await runsApi.heartbeatRunner(runnerGroup);
    const claim = await runsApi.claimRunnerJob(runId);
    expect(claim.prompt).toContain("please inspect this");
    expect(claim.prompt).toContain("[Teams file] spec.png (image/png)");
    expect(claim.appendSystemPrompt).toContain("zero teams download-file -h");

    const fileIdMatch = claim.prompt.match(/ {3}\[ID\] ([^\n]+)/u);
    const fileId = fileIdMatch?.[1];
    expect(fileId).toBeTruthy();
    expect(fileId).not.toContain(contentUrl);
    expect(fileId).toMatch(/^teams_file_[A-Za-z0-9_-]{22}$/u);

    const fileBytes = Buffer.from("teams file bytes");
    const expectedShareId = `u!${Buffer.from(contentUrl, "utf8").toString(
      "base64url",
    )}`;
    server.use(
      http.get(
        "https://graph.microsoft.com/v1.0/shares/:shareId/driveItem/content",
        ({ params, request }) => {
          expect(params.shareId).toBe(expectedShareId);
          expect(request.headers.get("authorization")).toBe(
            "Bearer teams-graph-token",
          );
          return new HttpResponse(fileBytes, {
            status: 200,
            headers: {
              "content-type": "image/png",
              "content-length": String(fileBytes.length),
            },
          });
        },
      ),
    );

    const app = createAppWithRoutes({
      signal: context.signal,
      routes: ROUTES,
    });
    const downloadResponse = await app.request(
      `/api/zero/integrations/teams/download-file?${new URLSearchParams({
        file_id: fileId ?? "",
      }).toString()}`,
      {
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            runId,
          })}`,
        },
      },
    );

    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("content-type")).toBe("image/png");
    expect(downloadResponse.headers.get("x-file-mimetype")).toBe("image/png");
    expect(downloadResponse.headers.get("x-file-name")).toBe("spec.png");
    const receivedBytes = Buffer.from(await downloadResponse.arrayBuffer());
    expect(receivedBytes.equals(fileBytes)).toBeTruthy();
  });

  it("uses short file ids for Teams personal attachments", async () => {
    const { fixture, actor, runnerGroup } = await setupConnectedTeamsBotActor();
    const downloadUrl = new URL(
      "https://contoso.sharepoint.com/_layouts/15/download.aspx",
    );
    downloadUrl.searchParams.set("tempauth", "a".repeat(1400));
    const fileBytes = Buffer.from("teams personal file bytes");
    server.use(
      http.get(downloadUrl.origin + downloadUrl.pathname, () => {
        return new HttpResponse(fileBytes, {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": String(fileBytes.length),
          },
        });
      }),
    );

    const response = await postTeamsActivity({
      activity: {
        ...teamsPersonalMessageActivity({
          fixture,
          id: "activity-personal-file",
          text: "inspect this personal attachment",
        }),
        attachments: [
          {
            id: "personal-attachment-1",
            contentType: "application/vnd.microsoft.teams.file.download.info",
            content: {
              downloadUrl: downloadUrl.toString(),
              fileName: "personal.png",
            },
          },
        ],
      },
      token: teamsToken(),
    });
    expect(response.status).toBe(200);
    await readTeamsBotResponseAndFlush(response);

    const list = await runsApi.listAgentRuns(actor, { limit: 20 });
    const run = list.runs.find((item) => {
      return item.prompt.includes("inspect this personal attachment");
    });
    if (!run) {
      throw new Error("Expected Teams personal file run");
    }
    await runsApi.heartbeatRunner(runnerGroup);
    const claim = await runsApi.claimRunnerJob(run.id);
    const fileId = claim.prompt.match(/ {3}\[ID\] ([^\n]+)/u)?.[1];
    expect(fileId).toMatch(/^teams_file_[A-Za-z0-9_-]{22}$/u);
    expect(fileId?.length).toBeLessThan(64);

    const app = createAppWithRoutes({
      signal: context.signal,
      routes: ROUTES,
    });
    const downloadResponse = await app.request(
      `/api/zero/integrations/teams/download-file?${new URLSearchParams({
        file_id: fileId ?? "",
      }).toString()}`,
      {
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            runId: run.id,
          })}`,
        },
      },
    );

    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("x-file-name")).toBe("personal.png");
    expect(
      Buffer.from(await downloadResponse.arrayBuffer()).equals(fileBytes),
    ).toBeTruthy();

    const legacyFileId = legacyTeamsFileId({
      tenantId: fixture.teamsTenantId,
      url: downloadUrl.toString(),
      name: "personal.png",
      contentType: "image/png",
    });
    const legacyDownloadResponse = await app.request(
      `/api/zero/integrations/teams/download-file?${new URLSearchParams({
        file_id: legacyFileId,
      }).toString()}`,
      {
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
          })}`,
        },
      },
    );
    expect(legacyDownloadResponse.status).toBe(200);
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
    const body = await response.json();
    expect(body).toMatchObject({
      activity: {
        kind: "message",
        text: "ask @Grace Hopper (29:user-2) to review",
        mentionsRecipient: true,
      },
    });
    expect(body).not.toHaveProperty("dispatch");
    await flushWaitUntilForTest();
  });

  it("handles connected Teams bot commands", async () => {
    const { fixture, actor, outboundRequests } =
      await setupConnectedTeamsBotActor();
    const switchAgent = await authOrgApi.createAgent(actor, {
      displayName: "Teams support agent",
      visibility: "public",
    });
    outboundRequests.splice(0, outboundRequests.length);

    const helpResponse = await postTeamsActivity({
      activity: teamsPersonalMessageActivity({
        fixture,
        id: "activity-command-help",
        text: "/help",
      }),
      token: teamsToken(),
    });
    expect(helpResponse.status).toBe(200);
    const helpBody = await readTeamsBotResponseAndFlush(helpResponse);
    expect(helpBody).not.toHaveProperty("dispatch");

    const connectResponse = await postTeamsActivity({
      activity: teamsPersonalMessageActivity({
        fixture,
        id: "activity-command-connect",
        text: "/connect",
      }),
      token: teamsToken(),
    });
    expect(connectResponse.status).toBe(200);
    const connectBody = await readTeamsBotResponseAndFlush(connectResponse);
    expect(connectBody).not.toHaveProperty("dispatch");

    const switchResponse = await postTeamsActivity({
      activity: teamsPersonalMessageActivity({
        fixture,
        id: "activity-command-switch",
        text: "/switch",
      }),
      token: teamsToken(),
    });
    expect(switchResponse.status).toBe(200);
    const switchBody = await readTeamsBotResponseAndFlush(switchResponse);
    expect(switchBody).not.toHaveProperty("dispatch");

    const modelResponse = await postTeamsActivity({
      activity: teamsPersonalMessageActivity({
        fixture,
        id: "activity-command-model",
        text: "/model",
      }),
      token: teamsToken(),
    });
    expect(modelResponse.status).toBe(200);
    const modelBody = await readTeamsBotResponseAndFlush(modelResponse);
    expect(modelBody).not.toHaveProperty("dispatch");

    const switchSubmitResponse = await postTeamsActivity({
      activity: teamsPersonalMessageActivity({
        fixture,
        id: "activity-command-switch-submit",
        text: "",
        value: {
          zeroTeamsAction: "switch_agent",
          selectedComposeId: switchAgent.agentId,
        },
      }),
      token: teamsToken(),
    });
    expect(switchSubmitResponse.status).toBe(200);
    const switchSubmitBody =
      await readTeamsBotResponseAndFlush(switchSubmitResponse);
    expect(switchSubmitBody).toMatchObject({
      activity: {
        value: {
          zeroTeamsAction: "switch_agent",
          selectedComposeId: switchAgent.agentId,
        },
      },
    });
    expect(switchSubmitBody).not.toHaveProperty("dispatch");
    const modelSubmitResponse = await postTeamsActivity({
      activity: teamsPersonalMessageActivity({
        fixture,
        id: "activity-command-model-submit",
        text: "",
        value: {
          zeroTeamsAction: "switch_model",
          selectedModel: "claude-sonnet-4-6",
        },
      }),
      token: teamsToken(),
    });
    expect(modelSubmitResponse.status).toBe(200);
    const modelSubmitBody =
      await readTeamsBotResponseAndFlush(modelSubmitResponse);
    expect(modelSubmitBody).toMatchObject({
      activity: {
        value: {
          zeroTeamsAction: "switch_model",
          selectedModel: "claude-sonnet-4-6",
        },
      },
    });
    expect(modelSubmitBody).not.toHaveProperty("dispatch");
    await expect(
      userConfigApi.readModelPreference(actor),
    ).resolves.toMatchObject({
      selectedModel: "claude-sonnet-4-6",
    });

    expect(outboundRequests).toHaveLength(6);
    expect(
      outboundRequests.map((request) => {
        return request.activityId;
      }),
    ).toStrictEqual([
      "activity-command-help",
      "activity-command-connect",
      "activity-command-switch",
      "activity-command-model",
      "activity-command-switch-submit",
      "activity-command-model-submit",
    ]);
    expect(outboundRequests[0]?.body).toMatchObject({
      type: "message",
      text: expect.stringContaining("Okou Teams Bot Help"),
    });
    expect(outboundRequests[1]?.body).toMatchObject({
      type: "message",
      text: expect.stringContaining("You're already connected"),
    });
    expect(outboundRequests[2]?.body).toMatchObject({
      type: "message",
      summary: expect.stringContaining("Choose which agent should respond"),
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: {
            type: "AdaptiveCard",
            version: "1.4",
            body: expect.arrayContaining([
              expect.objectContaining({
                type: "Input.ChoiceSet",
                id: "selectedComposeId",
                choices: expect.arrayContaining([
                  expect.objectContaining({
                    title: expect.stringContaining("Use org default"),
                    value: "__org_default__",
                  }),
                  expect.objectContaining({
                    title: "Teams support agent",
                    value: switchAgent.agentId,
                  }),
                ]),
              }),
            ]),
            actions: [
              {
                type: "Action.Submit",
                title: "Switch",
                data: { zeroTeamsAction: "switch_agent" },
              },
            ],
          },
        },
      ],
    });
    expect(outboundRequests[3]?.body).toMatchObject({
      type: "message",
      summary: expect.stringContaining("Choose the model"),
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: {
            type: "AdaptiveCard",
            version: "1.4",
            body: expect.arrayContaining([
              expect.objectContaining({
                type: "Input.ChoiceSet",
                id: "selectedModel",
                choices: expect.arrayContaining([
                  expect.objectContaining({
                    title: expect.stringContaining("Claude Sonnet 4.6"),
                    value: "claude-sonnet-4-6",
                  }),
                ]),
              }),
            ]),
            actions: [
              {
                type: "Action.Submit",
                title: "Switch",
                data: { zeroTeamsAction: "switch_model" },
              },
            ],
          },
        },
      ],
    });
    expect(outboundRequests[4]?.body).toMatchObject({
      type: "message",
      text: expect.stringContaining("Teams support agent"),
    });
    expect(outboundRequests[5]?.body).toMatchObject({
      type: "message",
      text: expect.stringContaining("Claude Sonnet 4.6"),
    });

    outboundRequests.splice(0, outboundRequests.length);
    const switchedRunResponse = await postTeamsActivity({
      activity: teamsPersonalMessageActivity({
        fixture,
        id: "activity-command-switch-run",
        text: "run after switch",
      }),
      token: teamsToken(),
    });
    expect(switchedRunResponse.status).toBe(200);
    const switchedRunBody =
      await readTeamsBotResponseAndFlush(switchedRunResponse);
    expect(switchedRunBody).not.toHaveProperty("dispatch");
    const switchedRunId = await runIdForPrompt(actor, "run after switch");
    await expect(
      runsApi.listAgentRuns(actor, { limit: 10 }),
    ).resolves.toMatchObject({
      runs: expect.arrayContaining([
        expect.objectContaining({
          appendSystemPrompt: expect.stringContaining(
            "Your name is Teams support agent.",
          ),
          prompt: "run after switch",
        }),
      ]),
    });
    await runsApi.requestCancelRun(actor, switchedRunId, [200]);

    outboundRequests.splice(0, outboundRequests.length);
    const disconnectResponse = await postTeamsActivity({
      activity: teamsPersonalMessageActivity({
        fixture,
        id: "activity-command-disconnect",
        text: "/disconnect",
      }),
      token: teamsToken(),
    });
    expect(disconnectResponse.status).toBe(200);
    const disconnectBody =
      await readTeamsBotResponseAndFlush(disconnectResponse);
    expect(disconnectBody).not.toHaveProperty("dispatch");
    expect(outboundRequests).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: expect.objectContaining({
            type: "message",
            text: expect.stringContaining("agent access has been revoked"),
          }),
        }),
      ]),
    );
  });

  it("replies when a connected Teams run is queued", async () => {
    const { fixture, actor, outboundRequests } =
      await setupConnectedTeamsBotActor();
    outboundRequests.splice(0, outboundRequests.length);

    const firstResponse = await postTeamsActivity({
      activity: teamsPersonalMessageActivity({
        fixture,
        id: "activity-queue-active-1",
        text: "active run one",
      }),
      token: teamsToken(),
    });
    expect(firstResponse.status).toBe(200);
    const firstBody = await readTeamsBotResponseAndFlush(firstResponse);
    expect(firstBody).not.toHaveProperty("dispatch");
    const firstRunId = await runIdForPrompt(actor, "active run one");

    const secondResponse = await postTeamsActivity({
      activity: teamsPersonalMessageActivity({
        fixture,
        id: "activity-queue-active-2",
        text: "active run two",
      }),
      token: teamsToken(),
    });
    expect(secondResponse.status).toBe(200);
    const secondBody = await readTeamsBotResponseAndFlush(secondResponse);
    expect(secondBody).not.toHaveProperty("dispatch");
    const secondRunId = await runIdForPrompt(actor, "active run two");

    const queuedResponse = await postTeamsActivity({
      activity: teamsPersonalMessageActivity({
        fixture,
        id: "activity-queue-third",
        text: "queued run three",
      }),
      token: teamsToken(),
    });
    expect(queuedResponse.status).toBe(200);
    const queuedBody = await readTeamsBotResponseAndFlush(queuedResponse);
    expect(queuedBody).not.toHaveProperty("dispatch");
    const queuedRunId = await runIdForPrompt(actor, "queued run three");

    expect(outboundRequests).toHaveLength(4);
    expect(
      outboundRequests.slice(0, 3).map((request) => {
        return request.body;
      }),
    ).toStrictEqual([
      {
        type: "typing",
        channelData: { tenant: { id: fixture.teamsTenantId } },
      },
      {
        type: "typing",
        channelData: { tenant: { id: fixture.teamsTenantId } },
      },
      {
        type: "typing",
        channelData: { tenant: { id: fixture.teamsTenantId } },
      },
    ]);
    expect(outboundRequests[3]).toMatchObject({
      activityId: "activity-queue-third",
      body: {
        type: "message",
        summary: expect.stringContaining("Run queued"),
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: {
              type: "AdaptiveCard",
              version: "1.4",
              body: expect.arrayContaining([
                expect.objectContaining({ text: "Run queued" }),
              ]),
              actions: [
                {
                  type: "Action.OpenUrl",
                  title: "View queue",
                  url: `${APP_ORIGIN}/?queue=1`,
                },
              ],
            },
          },
        ],
      },
    });
    expect(outboundRequests[3]?.body).not.toHaveProperty("text");
    expect(outboundRequests.reactions).toHaveLength(0);

    await runsApi.requestCancelRun(actor, queuedRunId, [200]);
    await runsApi.requestCancelRun(actor, firstRunId, [200]);
    await runsApi.requestCancelRun(actor, secondRunId, [200]);
  });

  it("sends typing and adds audit/footer text for Teams run pre-dispatch failures", async () => {
    const fixture = await trackTeamsFixture(
      Promise.resolve(teamsConnectFixture()),
    );
    const actor = authOrgApi.user({
      userId: fixture.userId,
      orgId: fixture.orgId,
      orgRole: "org:admin",
    });
    context.mocks.ably.publish.mockResolvedValue(undefined);
    authOrgApi.acceptAgentStorageWrites();
    const defaultAgent = await authOrgApi.bootstrapOnboarding(actor, {
      displayName: "Teams default agent",
    });
    await authOrgApi.updateAgentMetadata(actor, defaultAgent.body.agentId, {
      visibility: "public",
    });
    const supportAgent = await authOrgApi.createAgent(actor, {
      displayName: "Teams support agent",
      visibility: "public",
    });
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          organization: { id: fixture.orgId },
          role: "org:admin",
        },
      ],
    });
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
    botFrameworkHandlers();
    const outboundRequests = teamsOutboundHandlers(fixture.serviceUrl);

    const installResponse = await postTeamsActivity({
      activity: teamsMessageActivity(fixture),
      token: teamsToken(),
    });
    expect(installResponse.status).toBe(200);
    await installResponse.json();
    await flushWaitUntilForTest();
    await connectTeamsFixture(fixture);

    outboundRequests.splice(0, outboundRequests.length);
    const switchResponse = await postTeamsActivity({
      activity: teamsPersonalMessageActivity({
        fixture,
        id: "activity-failure-switch-agent",
        text: "",
        value: {
          zeroTeamsAction: "switch_agent",
          selectedComposeId: supportAgent.agentId,
        },
      }),
      token: teamsToken(),
    });
    expect(switchResponse.status).toBe(200);
    const switchBody = await readTeamsBotResponseAndFlush(switchResponse);
    expect(switchBody).not.toHaveProperty("dispatch");

    outboundRequests.splice(0, outboundRequests.length);
    const failedResponse = await postTeamsActivity({
      activity: teamsPersonalMessageActivity({
        fixture,
        id: "activity-run-pre-dispatch-failure",
        text: "run without entitlement",
      }),
      token: teamsToken(),
    });
    expect(failedResponse.status).toBe(200);
    const body = await readTeamsBotResponseAndFlush(failedResponse);
    expect(body).not.toHaveProperty("dispatch");

    expect(outboundRequests).toHaveLength(2);
    expect(outboundRequests[0]).toMatchObject({
      body: {
        type: "typing",
        channelData: { tenant: { id: fixture.teamsTenantId } },
      },
    });
    expect(outboundRequests[1]).toMatchObject({
      activityId: "activity-run-pre-dispatch-failure",
      body: {
        type: "message",
        text: expect.stringContaining(`[Audit](${APP_ORIGIN}/activities)`),
        textFormat: "markdown",
      },
    });
    expect(outboundRequests[1]?.body).toMatchObject({
      text: expect.stringContaining("Sent via Teams support agent"),
    });
    expect(outboundRequests.reactions).toHaveLength(0);
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
    const defaultAgent = await authOrgApi.bootstrapOnboarding(actor, {
      displayName: "Teams default agent",
    });
    await authOrgApi.updateAgentMetadata(actor, defaultAgent.body.agentId, {
      visibility: "public",
    });
    await runsApi.grantProEntitlement(actor);
    await runsApi.ensureOrgModelProvider(actor);
    botFrameworkHandlers();
    const outboundRequests = teamsOutboundHandlers(fixture.serviceUrl);

    const installResponse = await postTeamsActivity({
      activity: teamsMessageActivity(fixture),
      token: teamsToken(),
    });
    expect(installResponse.status).toBe(200);
    await installResponse.json();
    await flushWaitUntilForTest();
    await connectTeamsFixture(fixture);
    outboundRequests.splice(0, outboundRequests.length);
    outboundRequests.reactions.splice(0, outboundRequests.reactions.length);

    const channelMessages: TeamsGraphMessageFixture[] = [];
    const threadRoots: Record<string, TeamsGraphMessageFixture> = {
      "root-dispatch": {
        id: "root-dispatch",
        text: "remember the deployment target",
        createdDateTime: "2026-06-30T09:10:00.000Z",
        senderId: fixture.teamsUserId,
        graphUserPrincipalName: "ada@example.com",
      },
    };
    const threadReplies: Record<string, TeamsGraphMessageFixture[]> = {
      "root-dispatch": [
        {
          id: "activity-context-1",
          text: 'confirm with <at id="0">Grace Hopper</at> that the target is staging',
          createdDateTime: "2026-06-30T09:11:00.000Z",
          senderId: fixture.teamsUserId,
          mentions: [
            {
              id: 0,
              mentionText: '<at id="0">Grace Hopper</at>',
              mentioned: {
                user: {
                  id: "29:user-grace",
                  displayName: "Grace Hopper",
                },
              },
            },
          ],
          attachments: [
            {
              id: "teams-file-plan-1",
              name: "deployment-plan.pdf",
              contentType: "application/vnd.microsoft.teams.file.download.info",
              content: {
                downloadUrl: "https://files.example.test/deployment-plan.pdf",
                fileType: "pdf",
              },
            },
          ],
        },
        {
          id: "activity-context-file-only",
          text: "",
          createdDateTime: "2026-06-30T09:11:30.000Z",
          senderId: fixture.teamsUserId,
          attachments: [
            {
              id: "teams-file-checklist-1",
              name: "release-checklist.txt",
              contentType: "application/vnd.microsoft.teams.file.download.info",
              content: {
                downloadUrl: "https://files.example.test/release-checklist.txt",
                fileType: "txt",
              },
            },
          ],
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
    const channelContextBody = await readTeamsBotResponseAndFlush(
      channelContextResponse,
    );
    expect(channelContextBody).not.toHaveProperty("dispatch");
    expect(outboundRequests).toHaveLength(0);
    expect(outboundRequests.reactions).toStrictEqual([
      {
        method: "PUT",
        conversationId: "19:thread@thread.tacv2",
        activityId: "activity-channel-context-1",
        reactionType: "1f4ad_thoughtballoon",
      },
    ]);
    const channelContextRunId = await runIdForPrompt(
      actor,
      "start another topic",
    );
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
    const body = await readTeamsBotResponseAndFlush(response);
    expect(body).not.toHaveProperty("dispatch");
    expect(outboundRequests).toHaveLength(0);
    expect(outboundRequests.reactions).toStrictEqual([
      {
        method: "PUT",
        conversationId: "19:thread@thread.tacv2",
        activityId: "activity-channel-context-1",
        reactionType: "1f4ad_thoughtballoon",
      },
      {
        method: "PUT",
        conversationId: "19:thread@thread.tacv2",
        activityId: "activity-dispatch-1",
        reactionType: "1f4ad_thoughtballoon",
      },
    ]);

    const runId = await runIdForPrompt(actor, "ship the Teams dispatch");
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
    expect(appendSystemPrompt).toContain("zero teams --help");
    expect(appendSystemPrompt).toContain("zero teams message send -h");
    expect(appendSystemPrompt).toContain("zero teams download-file -h");
    expect(appendSystemPrompt).toContain("zero teams upload-file -h");
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
      `- SENDER: {id: ${fixture.teamsUserId}, name: Ada Lovelace, email: ada@example.com}`,
    );
    expect(teamsThreadContext).toContain("remember the deployment target");
    expect(teamsThreadContext).toContain(
      "confirm with @Grace Hopper (29:user-grace) that the target is staging",
    );
    expect(teamsThreadContext).toContain(
      "[Teams file] deployment-plan.pdf (application/pdf)",
    );
    expect(teamsThreadContext).toContain(
      "[Teams attachment ID] teams-file-plan-1",
    );
    expect(teamsThreadContext).toContain(
      "[Teams file] release-checklist.txt (text/plain)",
    );
    expect(teamsThreadContext).toContain(
      "[Teams attachment ID] teams-file-checklist-1",
    );
    expect(teamsThreadContext).not.toContain("ship the Teams dispatch");
    expect(graphRequests).toContain("thread-root:root-dispatch");
    expect(graphRequests).toContain("thread-replies:root-dispatch");
    expect(graphRequests).toContain(`user:${fixture.teamsUserId}`);
  });

  it("includes recent Teams personal messages in the run context", async () => {
    const { fixture, actor, runnerGroup, outboundRequests } =
      await setupConnectedTeamsBotActor();
    const personalChatId = "19:personal-test@unq.gbl.spaces";
    const graphRequests = teamsGraphHistoryHandlers({
      tenantId: fixture.teamsTenantId,
      teamsAppId: BOT_APP_ID,
      personalChatId,
      chatMessages: [
        {
          id: "activity-personal-thread-current",
          text: "continue this private task",
          createdDateTime: "2026-06-30T09:13:00.000Z",
          senderId: fixture.teamsUserId,
        },
        {
          id: "activity-personal-thread-prior-reply",
          text: "the target is staging",
          createdDateTime: "2026-06-30T09:12:00.000Z",
          senderId: fixture.teamsUserId,
        },
        {
          id: "activity-unrelated-personal-root",
          text: "unrelated private task",
          createdDateTime: "2026-06-30T09:11:00.000Z",
          senderId: fixture.teamsUserId,
        },
        {
          id: "activity-personal-thread-root",
          text: "remember the private deployment target",
          createdDateTime: "2026-06-30T09:10:00.000Z",
          senderId: fixture.teamsUserId,
        },
      ],
      channelMessages: [],
      threadRoots: {},
      threadReplies: {},
    });
    outboundRequests.splice(0, outboundRequests.length);

    const response = await postTeamsActivity({
      activity: {
        ...teamsPersonalMessageActivity({
          fixture,
          id: "activity-personal-thread-current",
          text: "continue this private task",
        }),
        channelData: {
          tenant: {
            id: fixture.teamsTenantId,
            name: fixture.teamsTenantName,
          },
        },
      },
      token: teamsToken(),
    });
    expect(response.status).toBe(200);
    const body = await readTeamsBotResponseAndFlush(response);
    expect(body).not.toHaveProperty("dispatch");
    const runId = await runIdForPrompt(actor, "continue this private task");
    await runsApi.heartbeatRunner(runnerGroup);
    const claim = await runsApi.claimRunnerJob(runId);
    const threadContext = promptSection(
      claim.appendSystemPrompt ?? "",
      "# Microsoft Teams Thread Context",
    );

    expect(claim.prompt).toBe("continue this private task");
    expect(threadContext).toContain("remember the private deployment target");
    expect(threadContext).toContain("the target is staging");
    expect(threadContext).toContain("unrelated private task");
    expect(threadContext).not.toContain("continue this private task");
    expect(graphRequests).toContain(
      `personal-installed-apps:${fixture.teamsAadObjectId}`,
    );
    expect(graphRequests).toContain(
      `personal-app-chat:${fixture.teamsAadObjectId}`,
    );
    expect(graphRequests).toContain(`chat-messages:${personalChatId}`);

    await runsApi.requestCancelRun(actor, runId, [200]);
  });

  it("includes Teams thread computer use host bindings in queued zero tokens", async () => {
    const { fixture, actor, runnerGroup } = await setupConnectedTeamsBotActor();
    const host = await computerUseApi.startComputerUseHost(actor, {
      hostName: "Teams authorized host",
    });
    const threadId = "teams-computer-use-thread";

    const firstResponse = await postTeamsActivity({
      activity: teamsPersonalThreadMessageActivity({
        fixture,
        id: "activity-computer-use-authorize",
        threadId,
        text: "authorize the browser",
      }),
      token: teamsToken(),
    });
    expect(firstResponse.status).toBe(200);
    const firstBody = await readTeamsBotResponseAndFlush(firstResponse);
    expect(firstBody).not.toHaveProperty("dispatch");

    const firstRunId = await runIdForPrompt(actor, "authorize the browser");
    await runsApi.heartbeatRunner(runnerGroup);
    const firstClaim = await runsApi.claimRunnerJob(firstRunId);
    const firstZeroToken = firstClaim.environment?.ZERO_TOKEN;
    if (!firstZeroToken) {
      throw new Error("Claimed Teams runner job did not include ZERO_TOKEN");
    }
    const created = await computerUseApi.createComputerUseAuthorizationRequest({
      bearer: firstZeroToken,
    });
    const requestToken = requestTokenFromUrl(created.authorizationUrl);
    await computerUseApi.applyComputerUseAuthorizationRequest(
      actor,
      requestToken,
      host.hostId,
    );
    await runsApi.requestCancelRun(actor, firstRunId, [200]);

    const secondResponse = await postTeamsActivity({
      activity: teamsPersonalThreadMessageActivity({
        fixture,
        id: "activity-computer-use-resume",
        threadId,
        text: "use the browser",
      }),
      token: teamsToken(),
    });
    expect(secondResponse.status).toBe(200);
    const secondBody = await readTeamsBotResponseAndFlush(secondResponse);
    expect(secondBody).not.toHaveProperty("dispatch");

    const secondRunId = await runIdForPrompt(actor, "use the browser");
    await runsApi.heartbeatRunner(runnerGroup);
    const secondClaim = await runsApi.claimRunnerJob(secondRunId);
    const secondZeroToken = secondClaim.environment?.ZERO_TOKEN;
    if (!secondZeroToken) {
      throw new Error("Claimed Teams runner job did not include ZERO_TOKEN");
    }
    const zeroAuth = verifyZeroToken(secondZeroToken);
    expect(zeroAuth).toMatchObject({ computerUseHostId: host.hostId });
    expect(zeroAuth?.capabilities).toContain("computer-use:write");

    await runsApi.requestCancelRun(actor, secondRunId, [200]);
    await computerUseApi.stopComputerUseHost(host.hostToken);
  });

  it("asks connected Teams users to configure a default agent", async () => {
    const fixture = await trackTeamsFixture(
      Promise.resolve(teamsConnectFixture()),
    );
    botFrameworkHandlers();
    const outboundRequests = teamsOutboundHandlers(fixture.serviceUrl);

    const installResponse = await postTeamsActivity({
      activity: teamsMessageActivity(fixture),
      token: teamsToken(),
    });
    expect(installResponse.status).toBe(200);
    await installResponse.json();
    await flushWaitUntilForTest();
    await connectTeamsFixture(fixture);

    const response = await postTeamsActivity({
      activity: teamsMessageActivity(fixture, {
        id: "activity-no-default",
        text: "<at>Zero</at> hello",
      }),
      token: teamsToken(),
    });

    expect(response.status).toBe(200);
    const body = await readTeamsBotResponseAndFlush(response);
    expect(body).not.toHaveProperty("dispatch");
    expect(outboundRequests.at(-1)).toMatchObject({
      activityId: "activity-no-default",
      body: {
        type: "message",
        text: expect.stringContaining("No agent is configured"),
        replyToId: "activity-no-default",
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
    await flushWaitUntilForTest();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context })(zeroTeamsConnectContract);
    await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          tenantId: fixture.teamsTenantId,
          teamsUserId: fixture.teamsUserId,
          teamsAadObjectId: fixture.teamsAadObjectId,
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
      connectUrl: teamsOauthConnectUrl(fixture),
    });
  });

  it("publishes Teams status changes when an install activity refreshes a bound installation", async () => {
    const fixture = botFixture();
    botFrameworkHandlers();
    context.mocks.ably.publish.mockResolvedValue(undefined);
    await installTeamsForTest(context.signal, fixture);
    await connectTeamsFixture(fixture);
    const actor = authOrgApi.user({
      userId: fixture.userId,
      orgId: fixture.orgId,
      orgRole: "org:admin",
    });
    authOrgApi.mockClerkOrg(actor);
    await authOrgApi.requestReadOrgWithBearer(
      zeroToken({ userId: fixture.userId, orgId: fixture.orgId }),
      [200],
    );
    context.mocks.ably.publish.mockClear();
    clearTeamsBotAuthCacheForTest();
    botFrameworkHandlers();

    const response = await postTeamsActivity({
      activity: teamsBotInstalledActivity(fixture),
      token: teamsToken(),
    });

    expect(response.status).toBe(200);
    await response.json();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "teams:changed",
      null,
    );
  });
});
