import type { ConnectorConfig } from "../connectors";

export const sentry = {
  sentry: {
    label: "Sentry",
    category: "engineering-team-execution",
    environmentMapping: {
      SENTRY_TOKEN: "$secrets.SENTRY_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Sentry account to access error tracking and project data",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Sentry to grant access.",
        secrets: {
          SENTRY_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          SENTRY_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      flow: "authorization-code",
      tokenUrl: "https://sentry.io/oauth/token/",
      client: {
        clientRegistration: "static",
        clientType: "confidential",
        tokenEndpointAuthMethod: "client_secret_post",
        clientIdEnv: "SENTRY_OAUTH_CLIENT_ID",
        clientSecretEnv: "SENTRY_OAUTH_CLIENT_SECRET",
      },
      scopes: [
        "org:read",
        "project:read",
        "team:read",
        "member:read",
        "event:read",
        "event:write",
      ],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
