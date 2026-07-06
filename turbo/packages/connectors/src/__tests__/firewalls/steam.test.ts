import { beforeAll, describe, expect, it } from "vitest";

import { findMatchingPermissions } from "../../firewall-rule-matcher";
import {
  extractSecretNamesFromApis,
  type FirewallConfig,
} from "../../firewall-types";
import {
  loadDefaultFirewallPolicies,
  loadRequiredConnectorFirewall,
} from "../firewall-test-helpers";

let firewall: FirewallConfig;

function expectSteamMatches(
  method: string,
  path: string,
  permissionNames: readonly string[],
): void {
  expect([...findMatchingPermissions(method, path, firewall)].sort()).toEqual(
    [...permissionNames].sort(),
  );
}

describe("steam firewall", () => {
  beforeAll(async () => {
    firewall = await loadRequiredConnectorFirewall("steam");
  });

  it("registers the Steam Web API firewall with query auth", () => {
    expect(firewall.name).toBe("steam");
    expect(firewall.apis).toHaveLength(1);
    expect(firewall.apis[0]).toMatchObject({
      base: "https://api.steampowered.com",
      auth: {
        query: {
          key: "${{ secrets.STEAM_WEB_API_KEY }}",
        },
      },
    });
    expect(extractSecretNamesFromApis([...firewall.apis])).toStrictEqual([
      "STEAM_WEB_API_KEY",
    ]);
  });

  it("maps Steam player data endpoints to read permissions", () => {
    expectSteamMatches("GET", "/ISteamUser/GetPlayerSummaries/v0002/", [
      "player-profile-read",
    ]);
    expectSteamMatches("GET", "/IPlayerService/GetOwnedGames/v0001/", [
      "player-library-read",
    ]);
    expectSteamMatches("GET", "/IPlayerService/GetRecentlyPlayedGames/v0001/", [
      "player-activity-read",
    ]);
    expectSteamMatches("GET", "/IPlayerService/GetSteamLevel/v1/", [
      "player-badges-read",
    ]);
    expectSteamMatches("GET", "/IPlayerService/GetBadges/v1/", [
      "player-badges-read",
    ]);
    expectSteamMatches("GET", "/IWishlistService/GetWishlist/v1/", [
      "player-wishlist-read",
    ]);
    expectSteamMatches("GET", "/IWishlistService/GetWishlistItemCount/v1/", [
      "player-wishlist-read",
    ]);
    expectSteamMatches("GET", "/IStoreService/GetGamesFollowed/v1/", [
      "player-followed-games-read",
    ]);
    expectSteamMatches("GET", "/IStoreService/GetGamesFollowedCount/v1/", [
      "player-followed-games-read",
    ]);
  });

  it("keeps unknown Steam Web API endpoints denied by default", async () => {
    const policy = await loadDefaultFirewallPolicies("steam");

    expect(policy.policies["player-profile-read"]).toBe("allow");
    expect(policy.policies["player-library-read"]).toBe("allow");
    expect(policy.policies["player-activity-read"]).toBe("allow");
    expect(policy.policies["player-badges-read"]).toBe("allow");
    expect(policy.policies["player-wishlist-read"]).toBe("allow");
    expect(policy.policies["player-followed-games-read"]).toBe("allow");
    expect(policy.unknownPolicy).toBe("deny");
  });
});
