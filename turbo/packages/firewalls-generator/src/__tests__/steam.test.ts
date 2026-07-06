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
    expect(officialMethodRules.get("IPlayerService/GetOwnedGames")).toContain(
      "GET /IPlayerService/GetOwnedGames/v0001/",
    );
    expect(officialMethodRules.get("IWishlistService/GetWishlist")).toContain(
      "GET /IWishlistService/GetWishlist/v1/",
    );
    expect(officialMethodRules.get("IStoreService/GetGamesFollowed")).toContain(
      "GET /IStoreService/GetGamesFollowed/v1/",
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
            "IPlayerService/GetOwnedGames",
            ["GET /IPlayerService/GetOwnedGames/v1/"],
          ],
          [
            "IPlayerService/GetRecentlyPlayedGames",
            ["GET /IPlayerService/GetRecentlyPlayedGames/v1/"],
          ],
          ["IPlayerService/GetBadges", ["GET /IPlayerService/GetBadges/v1/"]],
          [
            "IPlayerService/GetSteamLevel",
            ["GET /IPlayerService/GetSteamLevel/v1/"],
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
            "IStoreService/GetGamesFollowed",
            ["GET /IStoreService/GetGamesFollowed/v1/"],
          ],
          [
            "IStoreService/GetGamesFollowedCount",
            ["GET /IStoreService/GetGamesFollowedCount/v1/"],
          ],
        ]),
      );
    }).toThrow("read-only");
  });
});
