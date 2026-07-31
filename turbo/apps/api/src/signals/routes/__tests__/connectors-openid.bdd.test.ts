import { randomUUID } from "node:crypto";

import { connectorsSlugCallbackContract } from "@vm0/api-contracts/contracts/connectors-slug-callback";
import {
  zeroConnectorOpenIdStartContract,
  zeroConnectorOauthContinueContract,
  zeroConnectorsBySlugContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import { zeroConnectorCatalogContract } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { zeroSteamPlayerContract } from "@vm0/api-contracts/contracts/zero-steam-player";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

const STEAM_ID = "76561198000000000";

interface TestActor {
  readonly userId: string;
  readonly orgId: string;
}

function testActor(): TestActor {
  return {
    userId: `user_steam_${randomUUID()}`,
    orgId: `org_steam_${randomUUID()}`,
  };
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function mockSession(actor: TestActor): void {
  mocks.clerk.session(actor.userId, actor.orgId);
}

function mockSteamRuntimeEnv(): void {
  mockEnv("VM0_API_BACKEND_URL", "https://api.vm0.ai");
  mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
}

async function startSteamOpenId(actor: TestActor): Promise<URL> {
  mockSession(actor);
  const response = await accept(
    setupApp({ context })(zeroConnectorOpenIdStartContract).start({
      params: { connectorSlug: "steam" },
      headers: authHeaders(),
      body: { authMethod: "openid" },
    }),
    [200],
  );
  return new URL(response.body.authorizationUrl);
}

function stateFromSteamAuthorizationUrl(authorizationUrl: URL): string {
  const returnTo = authorizationUrl.searchParams.get("openid.return_to");
  if (!returnTo) {
    throw new Error("Steam authorization URL is missing openid.return_to");
  }
  const state = new URL(returnTo).searchParams.get("state");
  if (!state) {
    throw new Error("Steam return_to is missing state");
  }
  return state;
}

function steamCallbackQuery(authorizationUrl: URL) {
  const returnTo = authorizationUrl.searchParams.get("openid.return_to");
  if (!returnTo) {
    throw new Error("Steam authorization URL is missing openid.return_to");
  }
  const claimedId = `https://steamcommunity.com/openid/id/${STEAM_ID}`;
  return {
    state: stateFromSteamAuthorizationUrl(authorizationUrl),
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "id_res",
    "openid.op_endpoint": "https://steamcommunity.com/openid/login",
    "openid.claimed_id": claimedId,
    "openid.identity": claimedId,
    "openid.return_to": returnTo,
    "openid.response_nonce": "2026-07-06T00:00:00Znonce",
    "openid.assoc_handle": "assoc-handle",
    "openid.signed":
      "op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    "openid.sig": "signature",
  };
}

function mockSteamOpenIdVerification(valid = true): void {
  server.use(
    http.post(
      "https://steamcommunity.com/openid/login",
      async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        expect(body.get("openid.mode")).toBe("check_authentication");
        return new HttpResponse(
          [
            "ns:http://specs.openid.net/auth/2.0",
            `is_valid:${valid ? "true" : "false"}`,
            "",
          ].join("\n"),
          { headers: { "content-type": "text/plain" } },
        );
      },
    ),
  );
}

interface RedirectResponseLike {
  readonly headers: Headers;
}

function redirectLocation(response: RedirectResponseLike): URL {
  const location = response.headers.get("location");
  if (!location) {
    throw new Error("Expected a redirect location header");
  }
  return new URL(location);
}

function expectConnectorErrorRedirect(
  response: RedirectResponseLike,
  args: { readonly connectorSlug: string; readonly message: string },
): void {
  const url = redirectLocation(response);
  expect(url.pathname).toBe("/connector/error");
  expect(url.searchParams.get("connectorSlug")).toBe(args.connectorSlug);
  expect(url.searchParams.get("message")).toBe(args.message);
}

async function completeSteamOpenIdCallback(
  authorizationUrl: URL,
): Promise<void> {
  mockSteamOpenIdVerification();
  await accept(
    setupApp({ context })(connectorsSlugCallbackContract).callback({
      params: { connectorSlug: "steam" },
      query: steamCallbackQuery(authorizationUrl),
      headers: {},
    }),
    [307],
  );
}

function expectSteamApiKey(request: Request): URL {
  const url = new URL(request.url);
  expect(url.searchParams.get("key")).toBe("steam-web-api-key");
  expect(
    url.searchParams.get("steamid") ?? url.searchParams.get("steamids"),
  ).toBe(STEAM_ID);
  return url;
}

function mockSteamPlayerApis(args: { readonly privateOwnedGames?: boolean }) {
  mockEnv("STEAM_WEB_API_KEY", "steam-web-api-key");
  server.use(
    http.get(
      "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/",
      ({ request }) => {
        expectSteamApiKey(request);
        return HttpResponse.json({
          response: {
            players: [
              {
                steamid: STEAM_ID,
                personaname: "vm0-player",
                profileurl: `https://steamcommunity.com/profiles/${STEAM_ID}/`,
                avatarfull: "https://cdn.example.test/avatar.jpg",
                loccountrycode: "US",
                communityvisibilitystate: 3,
              },
            ],
          },
        });
      },
    ),
    http.get(
      "https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/",
      ({ request }) => {
        expectSteamApiKey(request);
        if (args.privateOwnedGames) {
          return HttpResponse.json({ response: {} });
        }
        return HttpResponse.json({
          response: {
            game_count: 1,
            games: [
              {
                appid: 10,
                name: "Counter-Strike",
                playtime_forever: 120,
                playtime_2weeks: 30,
                rtime_last_played: 1_725_000_000,
              },
            ],
          },
        });
      },
    ),
    http.get(
      "https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v0001/",
      ({ request }) => {
        expectSteamApiKey(request);
        return HttpResponse.json({
          response: {
            total_count: 1,
            games: [
              {
                appid: 20,
                name: "Team Fortress 2",
                playtime_forever: 240,
                playtime_2weeks: 60,
                rtime_last_played: 1_725_100_000,
              },
            ],
          },
        });
      },
    ),
    http.get(
      "https://api.steampowered.com/IPlayerService/GetSteamLevel/v1/",
      ({ request }) => {
        expectSteamApiKey(request);
        return HttpResponse.json({ response: { player_level: 42 } });
      },
    ),
    http.get(
      "https://api.steampowered.com/IPlayerService/GetBadges/v1/",
      ({ request }) => {
        expectSteamApiKey(request);
        return HttpResponse.json({
          response: {
            player_xp: 1234,
            player_level: 42,
            player_xp_needed_to_level_up: 200,
            player_xp_needed_current_level: 1000,
            badges: [
              {
                badgeid: 1,
                level: 2,
                completion_time: 1_725_200_000,
                xp: 100,
                scarcity: 0.1,
              },
            ],
          },
        });
      },
    ),
    http.get(
      "https://api.steampowered.com/IWishlistService/GetWishlist/v1/",
      ({ request }) => {
        expectSteamApiKey(request);
        return HttpResponse.json({
          response: {
            items: [
              {
                appid: 30,
                priority: 0,
                date_added: 1_725_300_000,
              },
              {
                appid: 40,
                priority: 1,
              },
            ],
          },
        });
      },
    ),
    http.get(
      "https://api.steampowered.com/IWishlistService/GetWishlistItemCount/v1/",
      ({ request }) => {
        expectSteamApiKey(request);
        return HttpResponse.json({ response: { count: 2 } });
      },
    ),
    http.get(
      "https://api.steampowered.com/IStoreService/GetGamesFollowed/v1/",
      ({ request }) => {
        expectSteamApiKey(request);
        return HttpResponse.json({ response: { appids: [50, 60] } });
      },
    ),
    http.get(
      "https://api.steampowered.com/IStoreService/GetGamesFollowedCount/v1/",
      ({ request }) => {
        expectSteamApiKey(request);
        return HttpResponse.json({
          response: { followed_game_count: 2 },
        });
      },
    ),
  );
}

describe("Steam OpenID connector", () => {
  it("rejects a legacy OAuth handoff without an authorization URL", async () => {
    const actor = testActor();
    mockSteamRuntimeEnv();
    const authorizationUrl = await startSteamOpenId(actor);

    const response = await accept(
      setupApp({ context })(zeroConnectorOauthContinueContract).continue({
        params: { connectorSlug: "steam" },
        query: { state: stateFromSteamAuthorizationUrl(authorizationUrl) },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "OAuth handoff not found",
        code: "NOT_FOUND",
      },
    });
  });

  it("exposes Steam in the connector catalog by default", async () => {
    const actor = testActor();
    mockSession(actor);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const visible = await accept(
      client.status({ headers: authHeaders() }),
      [200],
    );
    const steam = visible.body.connectors.find((connector) => {
      return connector.slug === "steam";
    });
    expect(steam).toMatchObject({
      slug: "steam",
      connected: false,
      authMethods: [
        expect.objectContaining({
          id: "openid",
          grantKind: "openid-auth",
        }),
      ],
    });
  });

  it("starts Steam OpenID auth and stores the verified SteamID on callback", async () => {
    const actor = testActor();
    mockSteamRuntimeEnv();

    const authorizationUrl = await startSteamOpenId(actor);
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      "https://steamcommunity.com/openid/login",
    );
    expect(authorizationUrl.searchParams.get("openid.realm")).toBe(
      "https://api.vm0.ai/",
    );
    expect(authorizationUrl.searchParams.get("openid.return_to")).toMatch(
      /^https:\/\/api\.vm0\.ai\/api\/connectors\/steam\/callback\?state=[0-9a-f]{64}$/u,
    );

    await completeSteamOpenIdCallback(authorizationUrl);

    mockSession(actor);
    const connector = await accept(
      setupApp({ context })(zeroConnectorsBySlugContract).get({
        params: { connectorSlug: "steam" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(connector.body).toMatchObject({
      slug: "steam",
      authMethod: "openid",
      externalId: STEAM_ID,
      externalUsername: STEAM_ID,
      connectionStatus: "connected",
    });
  });

  it("rejects invalid Steam OpenID verification without storing a connection", async () => {
    const actor = testActor();
    mockSteamRuntimeEnv();
    const authorizationUrl = await startSteamOpenId(actor);
    mockSteamOpenIdVerification(false);

    const response = await accept(
      setupApp({ context })(connectorsSlugCallbackContract).callback({
        params: { connectorSlug: "steam" },
        query: steamCallbackQuery(authorizationUrl),
        headers: {},
      }),
      [307],
    );

    expectConnectorErrorRedirect(response, {
      connectorSlug: "steam",
      message: "OpenID authorization failed. Please try again.",
    });

    mockSession(actor);
    const connector = await accept(
      setupApp({ context })(zeroConnectorsBySlugContract).get({
        params: { connectorSlug: "steam" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(connector.body.error.code).toBe("NOT_FOUND");
  });

  it("rejects OpenID start requests for non-OpenID connector methods", async () => {
    const actor = testActor();
    mockSession(actor);

    const response = await accept(
      setupApp({ context })(zeroConnectorOpenIdStartContract).start({
        params: { connectorSlug: "github" },
        headers: authHeaders(),
        body: { authMethod: "oauth" },
      }),
      [400],
    );
    expect(response.body.error.message).toContain("auth grant");
    expect(response.body.error.message).toContain("OpenID");
  });

  it("reads official Steam player data through the API-owned key", async () => {
    const actor = testActor();
    mockSteamRuntimeEnv();
    await completeSteamOpenIdCallback(await startSteamOpenId(actor));
    mockSteamPlayerApis({ privateOwnedGames: false });

    mockSession(actor);
    const response = await accept(
      setupApp({ context })(zeroSteamPlayerContract).getPlayer({
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      steamId: STEAM_ID,
      profile: {
        steamId: STEAM_ID,
        personaName: "vm0-player",
        communityVisibilityState: 3,
      },
      ownedGames: {
        gameCount: 1,
        games: [
          expect.objectContaining({
            appId: 10,
            name: "Counter-Strike",
            playtimeForeverMinutes: 120,
            playtimeTwoWeeksMinutes: 30,
          }),
        ],
      },
      recentlyPlayedGames: {
        totalCount: 1,
        games: [expect.objectContaining({ appId: 20 })],
      },
      level: 42,
      badges: {
        playerXp: 1234,
        playerLevel: 42,
        badges: [expect.objectContaining({ badgeId: 1, level: 2 })],
      },
      wishlist: {
        itemCount: 2,
        items: [
          {
            appId: 30,
            priority: 0,
            addedAt: "2024-09-02T18:00:00.000Z",
          },
          {
            appId: 40,
            priority: 1,
            addedAt: null,
          },
        ],
      },
      followedGames: {
        followedGameCount: 2,
        appIds: [50, 60],
      },
    });
  });

  it("keeps private owned game data distinct from an empty library", async () => {
    const actor = testActor();
    mockSteamRuntimeEnv();
    await completeSteamOpenIdCallback(await startSteamOpenId(actor));
    mockSteamPlayerApis({ privateOwnedGames: true });

    mockSession(actor);
    const response = await accept(
      setupApp({ context })(zeroSteamPlayerContract).getPlayer({
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.ownedGames).toBeNull();
    expect(response.body.recentlyPlayedGames).toMatchObject({
      totalCount: 1,
    });
  });

  it("returns provider unavailable when Steam returns malformed JSON", async () => {
    const actor = testActor();
    mockSteamRuntimeEnv();
    await completeSteamOpenIdCallback(await startSteamOpenId(actor));
    mockSteamPlayerApis({ privateOwnedGames: false });
    server.use(
      http.get(
        "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/",
        () => {
          return new HttpResponse("not-json", {
            headers: { "content-type": "application/json" },
          });
        },
      ),
    );

    mockSession(actor);
    const response = await accept(
      setupApp({ context })(zeroSteamPlayerContract).getPlayer({
        headers: authHeaders(),
      }),
      [503],
    );

    expect(response.body.error.code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("returns provider unavailable when Steam rejects the API key", async () => {
    const actor = testActor();
    mockSteamRuntimeEnv();
    await completeSteamOpenIdCallback(await startSteamOpenId(actor));
    mockSteamPlayerApis({ privateOwnedGames: false });
    server.use(
      http.get(
        "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/",
        () => {
          return new HttpResponse("", { status: 403 });
        },
      ),
    );

    mockSession(actor);
    const response = await accept(
      setupApp({ context })(zeroSteamPlayerContract).getPlayer({
        headers: authHeaders(),
      }),
      [503],
    );

    expect(response.body.error.code).toBe("PROVIDER_UNAVAILABLE");
  });
});
