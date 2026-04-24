import type { ConnectorConfig } from "../connectors";

export const strava = {
  strava: {
    label: "Strava",
    category: "data-automation-infrastructure",
    environmentMapping: {
      STRAVA_TOKEN: "$secrets.STRAVA_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Strava account to access activities and athlete data",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Strava to grant access.",
        secrets: {
          STRAVA_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          STRAVA_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://www.strava.com/oauth/authorize",
      tokenUrl: "https://www.strava.com/oauth/token",
      scopes: [
        "read",
        "profile:read_all",
        "activity:read_all",
        "activity:write",
      ],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
