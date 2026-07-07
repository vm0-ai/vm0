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
          "Connect PlayStation Network by pasting a temporary NPSSO token from your signed-in Sony account.",
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
          display: {
            instructions:
              "Open the PlayStation NPSSO page while signed in to Sony, then paste only the npsso value from the JSON response. NPSSO is sensitive; vm0 uses it once to create refreshable PlayStation tokens and does not store it. This connector uses community-observed, undocumented PlayStation Network APIs rather than an official third-party OAuth consent flow.",
            inputLabel: "NPSSO token",
            inputPlaceholder: "NPSSO token",
            openButtonLabel: "Open PlayStation NPSSO page",
            missingInputMessage: "Enter the PlayStation NPSSO token.",
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
