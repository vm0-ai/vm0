import { beforeAll, describe, expect, it } from "vitest";

import { fetchSpec } from "../codegen";
import {
  buildSteamOfficialMethodRules,
  buildSteamPermissions,
  parseSteamWebApiEndpoints,
  parseSteamSupportedApiListEndpoints,
  STEAM_SUPPORTED_API_LIST_URL,
  STEAM_PERMISSION_MANIFEST,
  STEAM_WEB_API_METHOD_DOC_URLS,
  validateSteamPermissionManifest,
  validateSteamOverview,
  type SteamSupportedApiList,
} from "../steam";

async function loadSteamMethodDocs(): Promise<string[]> {
  const docs: string[] = [];
  for (const url of STEAM_WEB_API_METHOD_DOC_URLS) {
    const response = await fetchSpec(url, `steam test docs page ${url}`);
    docs.push(await response.text());
  }
  return docs;
}

async function loadSteamSupportedApiList(): Promise<SteamSupportedApiList> {
  const response = await fetchSpec(
    STEAM_SUPPORTED_API_LIST_URL,
    "steam test supported API list",
  );
  return (await response.json()) as SteamSupportedApiList;
}

describe("Steam permission manifest", () => {
  let officialMethodRules: Map<string, string[]>;

  beforeAll(async () => {
    officialMethodRules = buildSteamOfficialMethodRules([
      ...parseSteamWebApiEndpoints(await loadSteamMethodDocs()),
      ...parseSteamSupportedApiListEndpoints(await loadSteamSupportedApiList()),
    ]);
  });

  it("matches the supported player methods in official Steam Web API docs", () => {
    expect(
      officialMethodRules.get("ISteamUser/GetPlayerSummaries"),
    ).toStrictEqual([
      "GET /ISteamUser/GetPlayerSummaries/v0002",
      "GET /ISteamUser/GetPlayerSummaries/v0002/",
      "GET /ISteamUser/GetPlayerSummaries/v2",
      "GET /ISteamUser/GetPlayerSummaries/v2/",
    ]);
    expect(officialMethodRules.get("ISteamUser/ResolveVanityURL")).toContain(
      "GET /ISteamUser/ResolveVanityURL/v1/",
    );
    expect(officialMethodRules.get("IPlayerService/GetOwnedGames")).toContain(
      "GET /IPlayerService/GetOwnedGames/v0001/",
    );
    expect(officialMethodRules.get("IWishlistService/GetWishlist")).toContain(
      "GET /IWishlistService/GetWishlist/v1/",
    );
    expect(officialMethodRules.get("IStoreService/GetGamesFollowed")).toContain(
      "GET /IStoreService/GetGamesFollowed/v1/",
    );
    expect(officialMethodRules.get("ISteamUser/GetFriendList")).toContain(
      "GET /ISteamUser/GetFriendList/v1/",
    );
    expect(officialMethodRules.get("ISteamUser/GetUserGroupList")).toContain(
      "GET /ISteamUser/GetUserGroupList/v1/",
    );
    expect(officialMethodRules.get("ISteamUser/GetPlayerBans")).toContain(
      "GET /ISteamUser/GetPlayerBans/v1/",
    );
    expect(
      officialMethodRules.get("ISteamUserStats/GetPlayerAchievements"),
    ).toContain("GET /ISteamUserStats/GetPlayerAchievements/v1/");
    expect(
      officialMethodRules.get("ISteamUserStats/GetUserStatsForGame"),
    ).toContain("GET /ISteamUserStats/GetUserStatsForGame/v2/");
    expect(
      officialMethodRules.get(
        "ISteamUserStats/GetGlobalAchievementPercentagesForApp",
      ),
    ).toContain(
      "GET /ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/",
    );
    expect(
      officialMethodRules.get("ISteamUserStats/GetGlobalStatsForGame"),
    ).toContain("GET /ISteamUserStats/GetGlobalStatsForGame/v1/");
    expect(
      officialMethodRules.get("ISteamUserStats/GetNumberOfCurrentPlayers"),
    ).toContain("GET /ISteamUserStats/GetNumberOfCurrentPlayers/v1/");
    expect(
      officialMethodRules.get("IPlayerService/GetSingleGamePlaytime"),
    ).toContain("GET /IPlayerService/GetSingleGamePlaytime/v1/");
    expect(
      officialMethodRules.get("IPlayerService/GetCommunityBadgeProgress"),
    ).toContain("GET /IPlayerService/GetCommunityBadgeProgress/v1/");
    expect(officialMethodRules.get("ISteamApps/GetAppList")).toContain(
      "GET /ISteamApps/GetAppList/v2/",
    );
    expect(
      officialMethodRules.get("ISteamWebAPIUtil/GetSupportedAPIList"),
    ).toContain("GET /ISteamWebAPIUtil/GetSupportedAPIList/v1/");
    expect(officialMethodRules.get("ISteamApps/GetSDRConfig")).toContain(
      "GET /ISteamApps/GetSDRConfig/v1/",
    );
    expect(officialMethodRules.get("IStoreService/GetAppList")).toContain(
      "GET /IStoreService/GetAppList/v1/",
    );
    expect(officialMethodRules.get("ISteamNews/GetNewsForApp")).toContain(
      "GET /ISteamNews/GetNewsForApp/v2/",
    );

    expect(() => {
      validateSteamPermissionManifest(
        officialMethodRules,
        STEAM_PERMISSION_MANIFEST,
      );
    }).not.toThrow();
  });

  it("builds read-only player permission groups from the official methods", () => {
    const permissions = buildSteamPermissions(officialMethodRules);

    expect(permissions.map((permission) => permission.name)).toStrictEqual([
      "player-profile-read",
      "player-library-read",
      "player-activity-read",
      "player-badges-read",
      "player-wishlist-read",
      "player-followed-games-read",
      "player-friends-read",
      "player-groups-read",
      "player-ban-status-read",
      "player-game-achievements-read",
      "player-game-stats-read",
      "steam-apps-read",
      "steam-news-read",
    ]);
    expect(
      permissions.find((permission) => permission.name === "player-badges-read")
        ?.rules,
    ).toContain("GET /IPlayerService/GetSteamLevel/v1/");
    expect(
      permissions.find(
        (permission) => permission.name === "player-wishlist-read",
      )?.rules,
    ).toContain("GET /IWishlistService/GetWishlistItemCount/v1/");
    expect(
      permissions.find(
        (permission) => permission.name === "player-followed-games-read",
      )?.rules,
    ).toContain("GET /IStoreService/GetGamesFollowedCount/v1/");
    expect(
      permissions.find(
        (permission) => permission.name === "player-game-stats-read",
      )?.rules,
    ).toContain("GET /ISteamUserStats/GetSchemaForGame/v2/");
    expect(
      permissions.find((permission) => permission.name === "steam-apps-read")
        ?.rules,
    ).toContain("GET /ISteamWebAPIUtil/GetSupportedAPIList/v1/");
    expect(
      permissions.find((permission) => permission.name === "steam-apps-read")
        ?.rules,
    ).toContain("GET /IStoreService/GetAppList/v1/");
    expect(
      permissions.find((permission) => permission.name === "steam-news-read")
        ?.rules,
    ).toContain("GET /ISteamNews/GetNewsForApp/v2/");
  });

  it("fails when a manifest method is absent from official docs", () => {
    expect(() => {
      validateSteamPermissionManifest(officialMethodRules, [
        {
          name: "broken",
          description: "Broken",
          methods: ["IPlayerService/NotARealSteamMethod"],
        },
      ]);
    }).toThrow("unknown official methods");
  });

  it("fails when a selected player permission is not read-only", () => {
    expect(() => {
      buildSteamPermissions(
        new Map([
          [
            "ISteamUser/GetPlayerSummaries",
            ["POST /ISteamUser/GetPlayerSummaries/v2/"],
          ],
          [
            "ISteamUser/ResolveVanityURL",
            ["GET /ISteamUser/ResolveVanityURL/v1/"],
          ],
          [
            "IPlayerService/GetOwnedGames",
            ["GET /IPlayerService/GetOwnedGames/v1/"],
          ],
          [
            "IPlayerService/GetRecentlyPlayedGames",
            ["GET /IPlayerService/GetRecentlyPlayedGames/v1/"],
          ],
          [
            "IPlayerService/GetSingleGamePlaytime",
            ["GET /IPlayerService/GetSingleGamePlaytime/v1/"],
          ],
          ["IPlayerService/GetBadges", ["GET /IPlayerService/GetBadges/v1/"]],
          [
            "IPlayerService/GetSteamLevel",
            ["GET /IPlayerService/GetSteamLevel/v1/"],
          ],
          [
            "IPlayerService/GetCommunityBadgeProgress",
            ["GET /IPlayerService/GetCommunityBadgeProgress/v1/"],
          ],
          [
            "IWishlistService/GetWishlist",
            ["GET /IWishlistService/GetWishlist/v1/"],
          ],
          [
            "IWishlistService/GetWishlistItemCount",
            ["GET /IWishlistService/GetWishlistItemCount/v1/"],
          ],
          [
            "IWishlistService/GetWishlistSortedFiltered",
            ["GET /IWishlistService/GetWishlistSortedFiltered/v1/"],
          ],
          [
            "IStoreService/GetGamesFollowed",
            ["GET /IStoreService/GetGamesFollowed/v1/"],
          ],
          [
            "IStoreService/GetGamesFollowedCount",
            ["GET /IStoreService/GetGamesFollowedCount/v1/"],
          ],
          ["ISteamUser/GetFriendList", ["GET /ISteamUser/GetFriendList/v1/"]],
          [
            "ISteamUser/GetUserGroupList",
            ["GET /ISteamUser/GetUserGroupList/v1/"],
          ],
          ["ISteamUser/GetPlayerBans", ["GET /ISteamUser/GetPlayerBans/v1/"]],
          [
            "ISteamUserStats/GetPlayerAchievements",
            ["GET /ISteamUserStats/GetPlayerAchievements/v1/"],
          ],
          [
            "ISteamUserStats/GetGlobalAchievementPercentagesForApp",
            ["GET /ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/"],
          ],
          [
            "ISteamUserStats/GetUserStatsForGame",
            ["GET /ISteamUserStats/GetUserStatsForGame/v2/"],
          ],
          [
            "ISteamUserStats/GetSchemaForGame",
            ["GET /ISteamUserStats/GetSchemaForGame/v2/"],
          ],
          [
            "ISteamUserStats/GetGlobalStatsForGame",
            ["GET /ISteamUserStats/GetGlobalStatsForGame/v1/"],
          ],
          [
            "ISteamUserStats/GetNumberOfCurrentPlayers",
            ["GET /ISteamUserStats/GetNumberOfCurrentPlayers/v1/"],
          ],
          ["ISteamApps/GetAppList", ["GET /ISteamApps/GetAppList/v2/"]],
          [
            "ISteamWebAPIUtil/GetSupportedAPIList",
            ["GET /ISteamWebAPIUtil/GetSupportedAPIList/v1/"],
          ],
          ["ISteamApps/GetSDRConfig", ["GET /ISteamApps/GetSDRConfig/v1/"]],
          [
            "ISteamApps/GetServersAtAddress",
            ["GET /ISteamApps/GetServersAtAddress/v1/"],
          ],
          ["ISteamApps/UpToDateCheck", ["GET /ISteamApps/UpToDateCheck/v1/"]],
          ["IStoreService/GetAppList", ["GET /IStoreService/GetAppList/v1/"]],
          ["ISteamNews/GetNewsForApp", ["GET /ISteamNews/GetNewsForApp/v2/"]],
        ]),
      );
    }).toThrow("read-only");
  });
});

describe("Steam overview validation", () => {
  it("requires api.steampowered.com as a parsed URL hostname", () => {
    expect(() => {
      validateSteamOverview(
        '<a href="https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/">Steam Web API</a>',
      );
    }).not.toThrow();

    expect(() => {
      validateSteamOverview(
        '<a href="https://attacker.example/redirect?next=https://api.steampowered.com">Steam Web API</a>',
      );
    }).toThrow("Steam Web API overview no longer documents");

    expect(() => {
      validateSteamOverview(
        '<a href="https://api.steampowered.com.attacker.example/">Steam Web API</a>',
      );
    }).toThrow("Steam Web API overview no longer documents");
  });
});
