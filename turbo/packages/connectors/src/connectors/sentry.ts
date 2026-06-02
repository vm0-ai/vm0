import type { ConnectorConfig } from "../connectors";

const OAUTH_TOKEN_URL = "https://sentry.io/oauth/token/";

export const sentry = {
  sentry: {
    label: "Sentry",
    category: "engineering-team-execution",
    helpText:
      "Connect your Sentry account to access error tracking and project data",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Sentry to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "SENTRY_OAUTH_CLIENT_ID",
          clientSecretEnv: "SENTRY_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["SENTRY_ACCESS_TOKEN", "SENTRY_REFRESH_TOKEN"],
          variables: [],
          secretRoles: {
            accessToken: "SENTRY_ACCESS_TOKEN",
            refreshToken: "SENTRY_REFRESH_TOKEN",
          },
        },
        grant: {
          kind: "auth-code",
          tokenUrl: OAUTH_TOKEN_URL,
          scopes: [
            "org:read",
            "project:read",
            "team:read",
            "member:read",
            "event:read",
            "event:write",
          ],
        },
        access: {
          kind: "refresh-token",
          tokenUrl: OAUTH_TOKEN_URL,
          envBindings: {
            SENTRY_TOKEN: "$secrets.SENTRY_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
