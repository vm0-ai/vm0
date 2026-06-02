import type { ConnectorConfig } from "../connectors";

const OAUTH_TOKEN_URL = "https://www.strava.com/oauth/token";

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
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "STRAVA_OAUTH_CLIENT_ID",
          clientSecretEnv: "STRAVA_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["STRAVA_ACCESS_TOKEN", "STRAVA_REFRESH_TOKEN"],
          variables: [],
          secretRoles: {
            accessToken: "STRAVA_ACCESS_TOKEN",
            refreshToken: "STRAVA_REFRESH_TOKEN",
          },
        },
        grant: {
          kind: "auth-code",
          tokenUrl: OAUTH_TOKEN_URL,
          scopes: [
            "read",
            "profile:read_all",
            "activity:read_all",
            "activity:write",
          ],
        },
        access: {
          kind: "refresh-token",
          tokenUrl: OAUTH_TOKEN_URL,
          envBindings: {
            STRAVA_TOKEN: "$secrets.STRAVA_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
