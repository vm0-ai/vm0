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

function expectNintendoStoreMatches(args: {
  readonly apiBase: string;
  readonly method: string;
  readonly path: string;
  readonly permissionNames: readonly string[];
}): void {
  expect(
    [
      ...findMatchingPermissions(args.method, args.path, firewall, {
        apiBase: args.apiBase,
      }),
    ].sort(),
  ).toStrictEqual([...args.permissionNames].sort());
}

describe("Nintendo Store firewall", () => {
  beforeAll(async () => {
    firewall = await loadRequiredConnectorFirewall("nintendo-store");
  });

  it("registers Nintendo Store APIs with the runtime token binding", () => {
    expect(firewall.name).toBe("nintendo-store");
    expect(firewall.apis).toHaveLength(2);
    expect(
      Object.fromEntries(
        firewall.apis.map((api) => {
          return [api.base, api.auth];
        }),
      ),
    ).toStrictEqual({
      "https://api.accounts.nintendo.com": {
        headers: {
          Authorization: "Bearer ${{ secrets.NINTENDO_STORE_TOKEN }}",
          "User-Agent": "com.nintendo.znej/1.13.0 (Android/7.1.2)",
        },
      },
      "https://app-api.znej.nintendo.com": {
        headers: {
          Authorization: "Bearer ${{ secrets.NINTENDO_STORE_TOKEN }}",
          "User-Agent": "com.nintendo.znej/1.13.0 (Android/7.1.2)",
          "gentry-locale": "${{ vars.NINTENDO_STORE_LOCALE }}",
        },
      },
    });
    expect(extractSecretNamesFromApis([...firewall.apis])).toStrictEqual([
      "NINTENDO_STORE_TOKEN",
    ]);
  });

  it("maps Nintendo account and Store app read endpoints to permissions", () => {
    expectNintendoStoreMatches({
      apiBase: "https://api.accounts.nintendo.com",
      method: "GET",
      path: "/2.0.0/users/me",
      permissionNames: ["nintendo-account-profile-read"],
    });
    expectNintendoStoreMatches({
      apiBase: "https://app-api.znej.nintendo.com",
      method: "GET",
      path: "/api/v2.0/users/me/play_histories",
      permissionNames: ["nintendo-store-play-activity-read"],
    });
    expectNintendoStoreMatches({
      apiBase: "https://app-api.znej.nintendo.com",
      method: "GET",
      path: "/api/v2.0/users/me/play_histories/game_titles/0100000000000000",
      permissionNames: ["nintendo-store-play-activity-read"],
    });
    expectNintendoStoreMatches({
      apiBase: "https://app-api.znej.nintendo.com",
      method: "GET",
      path: "/api/v2.0/products:search",
      permissionNames: ["nintendo-store-catalog-read"],
    });
    expectNintendoStoreMatches({
      apiBase: "https://app-api.znej.nintendo.com",
      method: "GET",
      path: "/api/v2.0/search_shelves/sale",
      permissionNames: ["nintendo-store-catalog-read"],
    });
    expectNintendoStoreMatches({
      apiBase: "https://app-api.znej.nintendo.com",
      method: "GET",
      path: "/api/v2.0/users/me/points",
      permissionNames: ["nintendo-store-account-read"],
    });
    expectNintendoStoreMatches({
      apiBase: "https://app-api.znej.nintendo.com",
      method: "GET",
      path: "/api/v2.0/users/me/wishlist",
      permissionNames: ["nintendo-store-wishlist-read"],
    });
    expectNintendoStoreMatches({
      apiBase: "https://app-api.znej.nintendo.com",
      method: "GET",
      path: "/api/v2.0/users/me/check_in_histories",
      permissionNames: ["nintendo-store-check-in-history-read"],
    });
    expectNintendoStoreMatches({
      apiBase: "https://news-api.entry.nintendo.co.jp",
      method: "GET",
      path: "/api/v1.1/users/me/play_histories",
      permissionNames: [],
    });
    expectNintendoStoreMatches({
      apiBase: "https://mypage-api.entry.nintendo.co.jp",
      method: "GET",
      path: "/api/v1/users/me/play_histories",
      permissionNames: [],
    });
  });

  it("denies unknown Nintendo Store paths by default", async () => {
    const policy = await loadDefaultFirewallPolicies("nintendo-store");

    expect(policy.policies["nintendo-account-profile-read"]).toBe("allow");
    expect(policy.policies["nintendo-store-account-read"]).toBe("allow");
    expect(policy.policies["nintendo-store-catalog-read"]).toBe("allow");
    expect(policy.policies["nintendo-store-check-in-history-read"]).toBe(
      "allow",
    );
    expect(policy.policies["nintendo-store-play-activity-read"]).toBe("allow");
    expect(policy.policies["nintendo-store-wishlist-read"]).toBe("allow");
    expect(policy.policies).not.toHaveProperty("my-nintendo-store-read");
    expect(policy.policies).not.toHaveProperty(
      "nintendo-entry-play-activity-read",
    );
    expect(policy.unknownPolicy).toBe("deny");
    expectNintendoStoreMatches({
      apiBase: "https://app-api.znej.nintendo.com",
      method: "GET",
      path: "/api/v2.0/users/me/profile",
      permissionNames: [],
    });
    expectNintendoStoreMatches({
      apiBase: "https://api.accounts.nintendo.com",
      method: "POST",
      path: "/2.0.0/users/me",
      permissionNames: [],
    });
    expectNintendoStoreMatches({
      apiBase: "https://app-api.znej.nintendo.com",
      method: "POST",
      path: "/api/v2.0/products:search",
      permissionNames: [],
    });
    expectNintendoStoreMatches({
      apiBase: "https://app-api.znej.nintendo.com",
      method: "GET",
      path: "/api/v2.0/users/me/play_histories/hidden_list",
      permissionNames: [],
    });
    expectNintendoStoreMatches({
      apiBase: "https://app-api.znej.nintendo.com",
      method: "POST",
      path: "/api/v2.0/check_in_events/event-id/check_in_points/point-id",
      permissionNames: [],
    });
    expectNintendoStoreMatches({
      apiBase: "https://app-api.znej.nintendo.com",
      method: "POST",
      path: "/api/v2.0/users/me/wishlist",
      permissionNames: [],
    });
    expectNintendoStoreMatches({
      apiBase: "https://app-api.znej.nintendo.com",
      method: "POST",
      path: "/api/v2.0/check_in_events/event-id/receive_prize",
      permissionNames: [],
    });
  });
});
