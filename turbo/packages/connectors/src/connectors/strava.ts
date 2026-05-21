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
      flow: "authorization-code",
      tokenUrl: "https://www.strava.com/oauth/token",
      client: {
        clientRegistration: "static",
        clientType: "confidential",
        tokenEndpointAuthMethod: "client_secret_post",
        clientIdEnv: "STRAVA_OAUTH_CLIENT_ID",
        clientSecretEnv: "STRAVA_OAUTH_CLIENT_SECRET",
      },
      scopes: [
        "read",
        "profile:read_all",
        "activity:read_all",
        "activity:write",
      ],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
