import { describe, expect, it } from "vitest";

import {
  getConnectorAuthMethodGrantMetadata,
  getConnectorAuthMethodIdsForGrantKind,
  getConnectorAuthMethodRuntimeMetadata,
  getConnectorOwnedSecretNames,
  getConnectorOwnedVariableNames,
} from "../connector-utils";

describe("Steam connector config", () => {
  it("declares an OpenID auth method that stores only the SteamID", () => {
    expect(
      getConnectorAuthMethodIdsForGrantKind("steam", "openid-auth"),
    ).toEqual(["openid"]);

    const grantMetadata = getConnectorAuthMethodGrantMetadata(
      "steam",
      "openid",
    );
    expect(grantMetadata?.outputs).toStrictEqual({
      steamId: {
        valueRef: "$vars.STEAM_ID",
        target: {
          kind: "connector-variable",
          name: "STEAM_ID",
        },
      },
    });
    expect(getConnectorOwnedVariableNames("steam", "openid")).toStrictEqual([
      "STEAM_ID",
    ]);
    expect(getConnectorOwnedSecretNames("steam", "openid")).toStrictEqual([]);
  });

  it("exposes only the non-secret SteamID to runtime metadata", () => {
    expect(getConnectorAuthMethodRuntimeMetadata("steam", "openid")).toEqual({
      storage: {
        secrets: [],
        variables: ["STEAM_ID"],
      },
      runtimeBindings: [
        {
          envName: "STEAM_ID",
          optional: false,
          source: {
            kind: "connector-variable",
            name: "STEAM_ID",
          },
          valueRef: "$vars.STEAM_ID",
        },
      ],
    });
  });
});
