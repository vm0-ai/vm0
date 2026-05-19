import type { ConnectorConfig } from "../connectors";

export const intervalsIcu = {
  "intervals-icu": {
    label: "Intervals.icu",
    category: "meetings-scheduling",
    environmentMapping: {
      INTERVALS_ICU_TOKEN: "$secrets.INTERVALS_ICU_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Intervals.icu account to access training, activity, wellness, and calendar data",
    authMethods: {
      oauth: {
        label: "OAuth",
        helpText: "Sign in with Intervals.icu to grant access.",
        secrets: {
          INTERVALS_ICU_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://intervals.icu/oauth/authorize",
      tokenUrl: "https://intervals.icu/api/oauth/token",
      client: {
        clientRegistration: "static",
        clientType: "confidential",
        tokenEndpointAuthMethod: "client_secret_post",
        clientIdEnv: "INTERVALS_ICU_OAUTH_CLIENT_ID",
        clientSecretEnv: "INTERVALS_ICU_OAUTH_CLIENT_SECRET",
      },
      scopes: ["ACTIVITY", "WELLNESS", "CALENDAR", "SETTINGS", "LIBRARY"],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
