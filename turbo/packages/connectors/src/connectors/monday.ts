import type { ConnectorConfig } from "../connectors";

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
        grant: {
          kind: "auth-code",
          tokenUrl: "https://auth.monday.com/oauth2/token",
          client: {
            clientRegistration: "static",
            clientType: "confidential",
            tokenEndpointAuthMethod: "client_secret_post",
            clientIdEnv: "MONDAY_OAUTH_CLIENT_ID",
            clientSecretEnv: "MONDAY_OAUTH_CLIENT_SECRET",
          },
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
          accessToken: "MONDAY_ACCESS_TOKEN",
          refreshToken: "MONDAY_REFRESH_TOKEN",
          outputs: {
            MONDAY_TOKEN: "$secrets.MONDAY_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
