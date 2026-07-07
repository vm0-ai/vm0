import type { ConnectorConfig } from "../connector-config";
import { FeatureSwitchKey } from "../feature-switch-key";

export const playstation = {
  playstation: {
    label: "PlayStation",
    category: "data-automation-infrastructure",
    tags: ["gaming", "player", "playstation", "psn"],
    helpText:
      "Connect your PlayStation Network account to access player profile, game, friends, presence, and trophy data.",
    authMethods: {
      api: {
        featureFlag: FeatureSwitchKey.PlaystationConnector,
        label: "PlayStation sign-in",
        helpText:
          "First make sure you are signed in to PlayStation at [https://www.playstation.com/](https://www.playstation.com/).\nClick the button below, then copy the `npsso` value.",
        client: {
          clientRegistration: "static",
          clientType: "public",
          clientId: "09515159-7237-4370-9b40-3806e67c0891",
        },
        storage: {
          secrets: [
            "PLAYSTATION_ACCESS_TOKEN",
            "PLAYSTATION_REFRESH_TOKEN",
            "PLAYSTATION_ID_TOKEN",
          ],
          variables: ["PLAYSTATION_ACCOUNT_ID", "PLAYSTATION_ONLINE_ID"],
        },
        grant: {
          kind: "external-code",
          scopes: ["psn:mobile.v2.core", "psn:clientapp"],
          outputs: {
            accessToken: "$secrets.PLAYSTATION_ACCESS_TOKEN",
            refreshToken: "$secrets.PLAYSTATION_REFRESH_TOKEN",
            idToken: "$secrets.PLAYSTATION_ID_TOKEN",
            accountId: "$vars.PLAYSTATION_ACCOUNT_ID",
            onlineId: "$vars.PLAYSTATION_ONLINE_ID",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.PLAYSTATION_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.PLAYSTATION_ACCESS_TOKEN",
            refreshToken: "$secrets.PLAYSTATION_REFRESH_TOKEN",
            idToken: "$secrets.PLAYSTATION_ID_TOKEN",
          },
          refreshableSecrets: ["PLAYSTATION_ACCESS_TOKEN"],
          envBindings: {
            PLAYSTATION_TOKEN: "$secrets.PLAYSTATION_ACCESS_TOKEN",
            PLAYSTATION_ACCOUNT_ID: {
              valueRef: "$vars.PLAYSTATION_ACCOUNT_ID",
              optional: true,
            },
            PLAYSTATION_ONLINE_ID: {
              valueRef: "$vars.PLAYSTATION_ONLINE_ID",
              optional: true,
            },
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
