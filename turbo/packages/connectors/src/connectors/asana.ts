import type { ConnectorConfig } from "../connectors";

export const asana = {
  asana: {
    label: "Asana",
    category: "engineering-team-execution",
    helpText:
      "Connect your Asana account to manage tasks, projects, portfolios, goals, and team workflows",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Asana to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "ASANA_OAUTH_CLIENT_ID",
          clientSecretEnv: "ASANA_OAUTH_CLIENT_SECRET",
        },
        grant: {
          kind: "auth-code",
          tokenUrl: "https://app.asana.com/-/oauth_token",
          scopes: [],
        },
        access: {
          kind: "refresh-token",
          accessToken: "ASANA_ACCESS_TOKEN",
          refreshToken: "ASANA_REFRESH_TOKEN",
          envBindings: {
            ASANA_TOKEN: "$secrets.ASANA_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
