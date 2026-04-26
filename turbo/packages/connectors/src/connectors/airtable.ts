import type { ConnectorConfig } from "../connectors";

export const airtable = {
  airtable: {
    label: "Airtable",
    category: "docs-files-knowledge",
    environmentMapping: {
      AIRTABLE_TOKEN: "$secrets.AIRTABLE_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Airtable account to access bases, tables, and records",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Airtable to grant access.",
        secrets: {
          AIRTABLE_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          AIRTABLE_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://airtable.com/oauth2/v1/authorize",
      tokenUrl: "https://airtable.com/oauth2/v1/token",
      scopes: [
        "data.records:read",
        "data.records:write",
        "data.recordComments:read",
        "data.recordComments:write",
        "schema.bases:read",
        "schema.bases:write",
        "user.email:read",
      ],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
