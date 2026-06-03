import type { ConnectorConfig } from "../connectors";

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
        },
        grant: {
          kind: "auth-code",
          scopes: [
            "org:read",
            "project:read",
            "team:read",
            "member:read",
            "event:read",
            "event:write",
          ],
          outputs: {
            accessToken: "$secrets.SENTRY_ACCESS_TOKEN",
            refreshToken: "$secrets.SENTRY_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.SENTRY_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.SENTRY_ACCESS_TOKEN",
            refreshToken: "$secrets.SENTRY_REFRESH_TOKEN",
          },
          refreshableSecrets: ["SENTRY_ACCESS_TOKEN"],
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
