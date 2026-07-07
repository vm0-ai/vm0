import { beforeAll, describe, expect, it } from "vitest";

import { findMatchingPermissions } from "../../firewall-rule-matcher";
import {
  extractSecretNamesFromApis,
  type FirewallConfig,
} from "../../firewall-types";
import { loadRequiredConnectorFirewall } from "../firewall-test-helpers";

let firewall: FirewallConfig;

function expectPlaystationMatches(
  method: string,
  path: string,
  permissionNames: readonly string[],
): void {
  expect(
    [...findMatchingPermissions(method, path, firewall)].sort(),
  ).toStrictEqual([...permissionNames].sort());
}

describe("PlayStation firewall", () => {
  beforeAll(async () => {
    firewall = await loadRequiredConnectorFirewall("playstation");
  });

  it("registers PlayStation APIs with the runtime token binding", () => {
    expect(firewall.name).toBe("playstation");
    expect(firewall.apis.map((api) => api.auth)).toStrictEqual(
      firewall.apis.map(() => {
        return {
          headers: {
            Authorization: "Bearer ${{ secrets.PLAYSTATION_TOKEN }}",
          },
        };
      }),
    );
    expect(extractSecretNamesFromApis([...firewall.apis])).toStrictEqual([
      "PLAYSTATION_TOKEN",
    ]);
  });

  it("maps PlayStation GraphQL games reads", () => {
    expectPlaystationMatches("GET", "/api/graphql/v1/op", [
      "playstation-graphql-games-read",
    ]);
  });
});
