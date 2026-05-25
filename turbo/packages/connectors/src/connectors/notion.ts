import type { ConnectorConfig } from "../connectors";

export const notion = {
  notion: {
    label: "Notion",
    category: "docs-files-knowledge",
    tags: ["docs", "wiki", "workspace"],
    helpText: "Connect your Notion workspace to access pages and databases",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Notion to grant access.",
        grant: {
          kind: "auth-code",
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
        access: {
          kind: "refresh-token",
          accessToken: "NOTION_ACCESS_TOKEN",
          refreshToken: "NOTION_REFRESH_TOKEN",
          outputs: {
            NOTION_TOKEN: "$secrets.NOTION_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
