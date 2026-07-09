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

function expectNintendoPlayActivityMatches(args: {
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

describe("Nintendo Play Activity firewall", () => {
  beforeAll(async () => {
    firewall = await loadRequiredConnectorFirewall("nintendo-play-activity");
  });

  it("registers Nintendo Play Activity APIs with the runtime token binding", () => {
    expect(firewall.name).toBe("nintendo-play-activity");
    expect(firewall.apis).toHaveLength(2);
    expect(
      firewall.apis.map((api) => {
        return api.auth;
      }),
    ).toStrictEqual(
      firewall.apis.map(() => {
        return {
          headers: {
            Authorization: "Bearer ${{ secrets.NINTENDO_PLAY_ACTIVITY_TOKEN }}",
          },
        };
      }),
    );
    expect(extractSecretNamesFromApis([...firewall.apis])).toStrictEqual([
      "NINTENDO_PLAY_ACTIVITY_TOKEN",
    ]);
  });

  it("maps both Nintendo play activity endpoints to read permissions", () => {
    expectNintendoPlayActivityMatches({
      apiBase: "https://app-api.znej.nintendo.com",
      method: "GET",
      path: "/api/v2.0/users/me/play_histories",
      permissionNames: ["nintendo-store-play-activity-read"],
    });
    expectNintendoPlayActivityMatches({
      apiBase: "https://mypage-api.entry.nintendo.co.jp",
      method: "GET",
      path: "/api/v1/users/me/play_histories",
      permissionNames: ["my-nintendo-play-activity-read"],
    });
  });

  it("denies unknown Nintendo Play Activity paths by default", async () => {
    const policy = await loadDefaultFirewallPolicies("nintendo-play-activity");

    expect(policy.policies["my-nintendo-play-activity-read"]).toBe("allow");
    expect(policy.policies["nintendo-store-play-activity-read"]).toBe("allow");
    expect(policy.unknownPolicy).toBe("deny");
    expectNintendoPlayActivityMatches({
      apiBase: "https://app-api.znej.nintendo.com",
      method: "GET",
      path: "/api/v2.0/users/me/profile",
      permissionNames: [],
    });
  });
});
