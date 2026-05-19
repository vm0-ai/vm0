import type { ConnectorConfig } from "../connectors";

export const notion = {
  notion: {
    label: "Notion",
    category: "docs-files-knowledge",
    tags: ["docs", "wiki", "workspace"],
    environmentMapping: {
      NOTION_TOKEN: "$secrets.NOTION_ACCESS_TOKEN",
    },
    helpText: "Connect your Notion workspace to access pages and databases",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Notion to grant access.",
        secrets: {
          NOTION_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          NOTION_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
      tokenUrl: "https://api.notion.com/v1/oauth/token",
      client: {
        clientRegistration: "static",
        clientType: "confidential",
        tokenEndpointAuthMethod: "client_secret_basic",
        clientIdEnv: "NOTION_OAUTH_CLIENT_ID",
        clientSecretEnv: "NOTION_OAUTH_CLIENT_SECRET",
      },
      scopes: [],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
