import type { ConnectorConfig } from "../connectors";

export const asana = {
  asana: {
    label: "Asana",
    environmentMapping: {
      ASANA_TOKEN: "$secrets.ASANA_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Asana account to manage tasks, projects, portfolios, goals, and team workflows",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Asana to grant access.",
        secrets: {
          ASANA_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          ASANA_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://app.asana.com/-/oauth_authorize",
      tokenUrl: "https://app.asana.com/-/oauth_token",
      scopes: [],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
