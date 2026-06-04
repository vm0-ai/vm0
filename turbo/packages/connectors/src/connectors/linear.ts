import type { ConnectorConfig } from "../connectors";

export const linear = {
  linear: {
    label: "Linear",
    category: "engineering-team-execution",
    tags: ["issues", "tickets", "project-management"],
    helpText: "Connect your Linear account to manage issues and projects",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Linear to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "LINEAR_OAUTH_CLIENT_ID",
          clientSecretEnv: "LINEAR_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["LINEAR_ACCESS_TOKEN", "LINEAR_REFRESH_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "auth-code",
          scopes: [
            "read",
            "write",
            "issues:create",
            "comments:create",
            "timeSchedule:write",
          ],
          outputs: {
            accessToken: "$secrets.LINEAR_ACCESS_TOKEN",
            refreshToken: "$secrets.LINEAR_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.LINEAR_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.LINEAR_ACCESS_TOKEN",
            refreshToken: "$secrets.LINEAR_REFRESH_TOKEN",
          },
          refreshableSecrets: ["LINEAR_ACCESS_TOKEN"],
          envBindings: {
            LINEAR_TOKEN: "$secrets.LINEAR_ACCESS_TOKEN",
          },
        },
        revoke: {
          kind: "token-revoke",
          inputs: {
            accessToken: "$secrets.LINEAR_ACCESS_TOKEN",
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
