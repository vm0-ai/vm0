import type { ConnectorConfig } from "../connector-config";
import { FeatureSwitchKey } from "../feature-switch-key";

export const nintendoPlayActivity = {
  "nintendo-play-activity": {
    label: "Nintendo Play Activity",
    category: "data-automation-infrastructure",
    tags: ["gaming", "player", "nintendo", "playtime"],
    helpText:
      "Connect your Nintendo Account to access Nintendo Store Play Activity and playtime data.",
    authMethods: {
      api: {
        featureFlag: FeatureSwitchKey.NintendoPlayActivityConnector,
        label: "Nintendo sign-in",
        helpText:
          "Sign in with Nintendo. After signing in, right-click the redirect button and copy its link address, then paste the full `npf...://auth` redirect URL or the `session_token_code` value.",
        client: {
          clientRegistration: "static",
          clientType: "public",
          clientId: "5c38e31cd085304b",
        },
        storage: {
          secrets: [
            "NINTENDO_PLAY_ACTIVITY_SESSION_TOKEN",
            "NINTENDO_PLAY_ACTIVITY_ACCESS_TOKEN",
            "NINTENDO_PLAY_ACTIVITY_ID_TOKEN",
          ],
          variables: [
            "NINTENDO_PLAY_ACTIVITY_ACCOUNT_ID",
            "NINTENDO_PLAY_ACTIVITY_LOCALE",
          ],
        },
        grant: {
          kind: "external-code",
          scopes: [
            "openid",
            "user",
            "user.mii",
            "user.email",
            "user.links[].id",
          ],
          outputs: {
            sessionToken: "$secrets.NINTENDO_PLAY_ACTIVITY_SESSION_TOKEN",
            accessToken: "$secrets.NINTENDO_PLAY_ACTIVITY_ACCESS_TOKEN",
            idToken: "$secrets.NINTENDO_PLAY_ACTIVITY_ID_TOKEN",
            accountId: "$vars.NINTENDO_PLAY_ACTIVITY_ACCOUNT_ID",
            locale: "$vars.NINTENDO_PLAY_ACTIVITY_LOCALE",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            sessionToken: "$secrets.NINTENDO_PLAY_ACTIVITY_SESSION_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.NINTENDO_PLAY_ACTIVITY_ACCESS_TOKEN",
            idToken: "$secrets.NINTENDO_PLAY_ACTIVITY_ID_TOKEN",
            locale: "$vars.NINTENDO_PLAY_ACTIVITY_LOCALE",
          },
          refreshableSecrets: ["NINTENDO_PLAY_ACTIVITY_ACCESS_TOKEN"],
          envBindings: {
            NINTENDO_PLAY_ACTIVITY_TOKEN:
              "$secrets.NINTENDO_PLAY_ACTIVITY_ACCESS_TOKEN",
            NINTENDO_PLAY_ACTIVITY_LOCALE:
              "$vars.NINTENDO_PLAY_ACTIVITY_LOCALE",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
