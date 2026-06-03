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
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "MONDAY_OAUTH_CLIENT_ID",
          clientSecretEnv: "MONDAY_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["MONDAY_ACCESS_TOKEN", "MONDAY_REFRESH_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "auth-code",
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
          outputs: {
            accessToken: "$secrets.MONDAY_ACCESS_TOKEN",
            refreshToken: "$secrets.MONDAY_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.MONDAY_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.MONDAY_ACCESS_TOKEN",
            refreshToken: "$secrets.MONDAY_REFRESH_TOKEN",
          },
          refreshableSecrets: ["MONDAY_ACCESS_TOKEN"],
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
