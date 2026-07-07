import { beforeAll, describe, expect, it } from "vitest";

import {
  buildPlaystationPermissionsByBase,
  loadPlaystationSourcePackage,
  parsePlaystationSourceEndpoints,
  type PlaystationSourceEndpoint,
} from "../playstation";

describe("PlayStation psn-api source parser", () => {
  let endpoints: PlaystationSourceEndpoint[];

  beforeAll(() => {
    endpoints = parsePlaystationSourceEndpoints(loadPlaystationSourcePackage());
  });

  it("extracts endpoint rules from cached psn-api source", () => {
    const rulesByFunction = new Map(
      endpoints.map((endpoint) => {
        return [endpoint.functionName, endpoint.rule] as const;
      }),
    );

    expect(rulesByFunction.get("getBasicPresence")).toBe(
      "GET /api/userProfile/v1/internal/users/{accountId}/basicPresences",
    );
    expect(rulesByFunction.get("getProfileShareableLink")).toBe(
      "GET /api/cpss/v1/share/profile/{accountId}",
    );
    expect(rulesByFunction.get("getProfileFromUserName")).toBe(
      "GET /userProfile/v1/users/{userName}/profile2",
    );
    expect(rulesByFunction.get("makeUniversalSearch")).toBe(
      "POST /api/search/v1/universalSearch",
    );
    expect(rulesByFunction.get("getAccountDevices")).toBe(
      "GET /api/v1/devices/accounts/{accountId}",
    );
  });

  it("builds firewall permission groups from parsed source endpoints", () => {
    const permissionsByBase = buildPlaystationPermissionsByBase(endpoints);
    const mobilePermissions =
      permissionsByBase.get("https://m.np.playstation.com") ?? [];
    const webPermissions =
      permissionsByBase.get("https://web.np.playstation.com") ?? [];

    expect(
      mobilePermissions.map((permission) => permission.name),
    ).toStrictEqual([
      "playstation-profile-read",
      "playstation-social-read",
      "playstation-games-read",
      "playstation-trophies-read",
      "playstation-search-read",
    ]);
    expect(
      mobilePermissions.find((permission) => {
        return permission.name === "playstation-trophies-read";
      })?.rules,
    ).toContain("GET /api/trophy/v1/users/{accountId}/trophySummary");
    expect(
      mobilePermissions.find((permission) => {
        return permission.name === "playstation-search-read";
      })?.rules,
    ).toStrictEqual(["POST /api/search/v1/universalSearch"]);
    expect(webPermissions).toStrictEqual([
      {
        name: "playstation-graphql-games-read",
        description:
          "Read PlayStation purchased and recently played game lists through psn-api GraphQL operations",
        rules: ["GET /api/graphql/v1/op"],
      },
    ]);
  });
});
