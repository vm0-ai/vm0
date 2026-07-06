import type { ConnectorConfig } from "../connector-config";
import { FeatureSwitchKey } from "../feature-switch-key";

export const steam = {
  steam: {
    label: "Steam",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Steam account to access player profile, game library, and playtime data.",
    authMethods: {
      openid: {
        featureFlag: FeatureSwitchKey.SteamConnector,
        label: "Steam sign-in",
        helpText: "Sign in with Steam to connect your player account.",
        storage: {
          secrets: [],
          variables: ["STEAM_ID"],
        },
        grant: {
          kind: "openid-auth",
          callbackOrigin: "api",
          outputs: {
            steamId: "$vars.STEAM_ID",
          },
        },
        access: {
          kind: "static",
          envBindings: {
            STEAM_ID: "$vars.STEAM_ID",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
