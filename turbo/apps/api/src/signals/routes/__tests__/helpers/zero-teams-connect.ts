import {
  createSign,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
} from "node:crypto";

import { HttpResponse, http } from "msw";

import { createAppWithRoutes } from "../../../../app-factory-core";
import { mockEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { server } from "../../../../mocks/server";
import { clearTeamsBotAuthCacheForTest } from "../../../../lib/teams-bot-auth";
import { zeroTeamsBotRoutes } from "../../zero-teams-bot";

const BOT_APP_ID = "00000000-0000-0000-0000-000000000001";
const SERVICE_URL = "https://smba.trafficmanager.net/amer/";
const KEY_ID = "teams-test-key";
const BOT_FRAMEWORK_METADATA_URL =
  "https://login.botframework.com/v1/.well-known/openidconfiguration";
const BOT_FRAMEWORK_KEYS_URL =
  "https://login.botframework.com/v1/.well-known/keys";

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = keyPair.publicKey.export({ format: "jwk" });

export interface TeamsConnectFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly teamsTenantId: string;
  readonly teamsTenantName: string;
  readonly teamsTeamId: string;
  readonly teamsTeamName: string;
  readonly teamsUserId: string;
  readonly serviceUrl: string;
}

export function setupTeamsConnectTestEnv(
  appUrl = "https://app.vm0.test",
): void {
  clearTeamsBotAuthCacheForTest();
  mockEnv("MICROSOFT_TEAMS_BOT_APP_ID", BOT_APP_ID);
  mockEnv("APP_URL", appUrl);
}

export function teamsConnectFixture(
  overrides: Partial<TeamsConnectFixture> = {},
): TeamsConnectFixture {
  return {
    orgId: overrides.orgId ?? `org_${randomUUID()}`,
    userId: overrides.userId ?? `user_${randomUUID()}`,
    teamsTenantId:
      overrides.teamsTenantId ??
      `tenant_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
    teamsTenantName: overrides.teamsTenantName ?? "Test Tenant",
    teamsTeamId:
      overrides.teamsTeamId ??
      `team_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
    teamsTeamName: overrides.teamsTeamName ?? "Test Team",
    teamsUserId: overrides.teamsUserId ?? `29:user-${randomUUID().slice(0, 8)}`,
    serviceUrl: overrides.serviceUrl ?? SERVICE_URL,
  };
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

function teamsToken(): string {
  const seconds = Math.floor(now() / 1000);
  return signJwt({
    privateKey: keyPair.privateKey,
    payload: {
      iss: "https://api.botframework.com",
      aud: BOT_APP_ID,
      exp: seconds + 600,
      nbf: seconds - 30,
      serviceurl: SERVICE_URL,
    },
  });
}

function teamsMessageActivity(
  fixture: TeamsConnectFixture,
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
  fixture: TeamsConnectFixture,
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

async function postTeamsActivityForTest(args: {
  readonly signal: AbortSignal;
  readonly activity: Record<string, unknown>;
}): Promise<Response> {
  clearTeamsBotAuthCacheForTest();
  mockEnv("MICROSOFT_TEAMS_BOT_APP_ID", BOT_APP_ID);
  botFrameworkHandlers();
  const app = createAppWithRoutes({
    signal: args.signal,
    routes: zeroTeamsBotRoutes,
  });
  return await app.request("http://api.test/api/zero/teams/bot", {
    method: "POST",
    headers: {
      authorization: `Bearer ${teamsToken()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(args.activity),
  });
}

export async function installTeamsForTest(
  signal: AbortSignal,
  fixture: TeamsConnectFixture,
): Promise<void> {
  const response = await postTeamsActivityForTest({
    signal,
    activity: teamsMessageActivity(fixture),
  });
  if (!response.ok) {
    throw new Error(`Teams install seed failed with ${response.status}`);
  }
}

export async function removeTeamsForTest(
  signal: AbortSignal,
  fixture: TeamsConnectFixture,
): Promise<void> {
  const response = await postTeamsActivityForTest({
    signal,
    activity: teamsBotRemovedActivity(fixture),
  });
  if (!response.ok) {
    throw new Error(`Teams cleanup failed with ${response.status}`);
  }
}
