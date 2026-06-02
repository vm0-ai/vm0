import type { ConnectorConfig } from "../connectors";

const OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token";

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
          secretRoles: {
            accessToken: "LINEAR_ACCESS_TOKEN",
            refreshToken: "LINEAR_REFRESH_TOKEN",
          },
        },
        grant: {
          kind: "auth-code",
          tokenUrl: OAUTH_TOKEN_URL,
          scopes: [
            "read",
            "write",
            "issues:create",
            "comments:create",
            "timeSchedule:write",
          ],
        },
        access: {
          kind: "refresh-token",
          tokenUrl: OAUTH_TOKEN_URL,
          envBindings: {
            LINEAR_TOKEN: "$secrets.LINEAR_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "token-revoke" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
