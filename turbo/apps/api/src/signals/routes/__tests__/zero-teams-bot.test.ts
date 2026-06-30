import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";

import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { testContext } from "../../../__tests__/test-context";
import { clearTeamsBotAuthCacheForTest } from "../../../lib/teams-bot-auth";
import { zeroTeamsBotRoutes } from "../zero-teams-bot";

const context = testContext();
const TEAMS_BOT_PATH = "http://api.test/api/zero/teams/bot";
const BOT_APP_ID = "00000000-0000-0000-0000-000000000001";
const SERVICE_URL = "https://smba.trafficmanager.net/amer/";
const KEY_ID = "teams-test-key";
const BOT_FRAMEWORK_METADATA_URL =
  "https://login.botframework.com/v1/.well-known/openidconfiguration";
const BOT_FRAMEWORK_KEYS_URL =
  "https://login.botframework.com/v1/.well-known/keys";

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = keyPair.publicKey.export({ format: "jwk" });

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
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    type: "message",
    id: "activity-1",
    timestamp: "2026-06-30T09:10:00.000Z",
    serviceUrl: SERVICE_URL,
    channelId: "msteams",
    conversation: {
      id: "19:thread@thread.tacv2",
      conversationType: "channel",
    },
    channelData: {
      tenant: { id: "tenant-1" },
      team: { id: "team-1", name: "Team One" },
      channel: { id: "19:channel@thread.tacv2", name: "General" },
    },
    from: {
      id: "29:user-1",
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

function teamsBotRemovedActivity(): Record<string, unknown> {
  return {
    type: "conversationUpdate",
    id: "activity-remove-1",
    timestamp: "2026-06-30T09:20:00.000Z",
    serviceUrl: SERVICE_URL,
    channelId: "msteams",
    conversation: {
      id: "19:thread@thread.tacv2",
      conversationType: "channel",
    },
    channelData: {
      tenant: { id: "tenant-1" },
      team: { id: "team-1", name: "Team One" },
      channel: { id: "19:channel@thread.tacv2", name: "General" },
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

describe("POST /api/zero/teams/bot", () => {
  beforeEach(() => {
    clearTeamsBotAuthCacheForTest();
    mockEnv("MICROSOFT_TEAMS_BOT_APP_ID", BOT_APP_ID);
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
    await expect(response.json()).resolves.toMatchObject({
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
        idempotencyKey: "19:thread@thread.tacv2:message:activity-1",
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
});
