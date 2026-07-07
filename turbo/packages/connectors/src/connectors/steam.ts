import type { ConnectorConfig } from "../connector-config";
import { FeatureSwitchKey } from "../feature-switch-key";

export const steam = {
  steam: {
    label: "Steam",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Steam account to access player profile, library, playtime, social, wishlist, and game stats data.",
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
          platformSecrets: ["STEAM_WEB_API_KEY"],
          envBindings: {
            STEAM_ID: "$vars.STEAM_ID",
            STEAM_WEB_API_KEY: "$secrets.STEAM_WEB_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
