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
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "STRAVA_OAUTH_CLIENT_ID",
          clientSecretEnv: "STRAVA_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["STRAVA_ACCESS_TOKEN", "STRAVA_REFRESH_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "auth-code",
          scopes: [
            "read",
            "profile:read_all",
            "activity:read_all",
            "activity:write",
          ],
          outputs: {
            accessToken: "$secrets.STRAVA_ACCESS_TOKEN",
            refreshToken: "$secrets.STRAVA_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.STRAVA_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.STRAVA_ACCESS_TOKEN",
            refreshToken: "$secrets.STRAVA_REFRESH_TOKEN",
          },
          refreshableSecrets: ["STRAVA_ACCESS_TOKEN"],
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
