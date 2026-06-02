import type { ConnectorConfig } from "../connectors";

const OAUTH_TOKEN_URL = "https://auth.monday.com/oauth2/token";

export const monday = {
  monday: {
    label: "Monday.com",
    category: "engineering-team-execution",
    helpText:
      "Connect your Monday.com account to manage boards, items, and workflows",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Monday.com to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "MONDAY_OAUTH_CLIENT_ID",
          clientSecretEnv: "MONDAY_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["MONDAY_ACCESS_TOKEN", "MONDAY_REFRESH_TOKEN"],
          variables: [],
          secretRoles: {
            accessToken: "MONDAY_ACCESS_TOKEN",
            refreshToken: "MONDAY_REFRESH_TOKEN",
          },
        },
        grant: {
          kind: "auth-code",
          tokenUrl: OAUTH_TOKEN_URL,
          scopes: [
            "me:read",
            "boards:read",
            "boards:write",
            "docs:read",
            "docs:write",
            "workspaces:read",
            "users:read",
            "account:read",
            "updates:read",
            "updates:write",
            "notifications:write",
            "assets:read",
            "tags:read",
            "teams:read",
          ],
        },
        access: {
          kind: "refresh-token",
          tokenUrl: OAUTH_TOKEN_URL,
          envBindings: {
            MONDAY_TOKEN: "$secrets.MONDAY_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
