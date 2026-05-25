import type { ConnectorConfig } from "../connectors";

export const strava = {
  strava: {
    label: "Strava",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Strava account to access activities and athlete data",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Strava to grant access.",
        grant: {
          kind: "auth-code",
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
        access: {
          kind: "refresh-token",
          accessToken: "STRAVA_ACCESS_TOKEN",
          refreshToken: "STRAVA_REFRESH_TOKEN",
          outputs: {
            STRAVA_TOKEN: "$secrets.STRAVA_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
