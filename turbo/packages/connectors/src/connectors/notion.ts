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
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "NOTION_OAUTH_CLIENT_ID",
          clientSecretEnv: "NOTION_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["NOTION_ACCESS_TOKEN", "NOTION_REFRESH_TOKEN"],
          variables: [],
          secretRoles: {
            accessToken: "NOTION_ACCESS_TOKEN",
            refreshToken: "NOTION_REFRESH_TOKEN",
          },
        },
        grant: {
          kind: "auth-code",
          scopes: [],
        },
        access: {
          kind: "refresh-token",
          envBindings: {
            NOTION_TOKEN: "$secrets.NOTION_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
