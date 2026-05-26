import type { ConnectorConfig } from "../connectors";

export const intervalsIcu = {
  "intervals-icu": {
    label: "Intervals.icu",
    category: "meetings-scheduling",
    helpText:
      "Connect your Intervals.icu account to access training, activity, wellness, and calendar data",
    authMethods: {
      oauth: {
        label: "OAuth",
        helpText: "Sign in with Intervals.icu to grant access.",
        grant: {
          kind: "auth-code",
          tokenUrl: "https://intervals.icu/api/oauth/token",
          client: {
            clientRegistration: "static",
            clientType: "confidential",
            clientIdEnv: "INTERVALS_ICU_OAUTH_CLIENT_ID",
            clientSecretEnv: "INTERVALS_ICU_OAUTH_CLIENT_SECRET",
          },
          scopes: ["ACTIVITY", "WELLNESS", "CALENDAR", "SETTINGS", "LIBRARY"],
        },
        access: {
          kind: "static",
          outputs: {
            INTERVALS_ICU_TOKEN: "$secrets.INTERVALS_ICU_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
