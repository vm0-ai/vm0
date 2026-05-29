import type { ConnectorConfig } from "../connectors";

export const airtable = {
  airtable: {
    label: "Airtable",
    category: "docs-files-knowledge",
    helpText:
      "Connect your Airtable account to access bases, tables, and records",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Airtable to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "AIRTABLE_OAUTH_CLIENT_ID",
          clientSecretEnv: "AIRTABLE_OAUTH_CLIENT_SECRET",
        },
        grant: {
          kind: "auth-code",
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
        access: {
          kind: "refresh-token",
          accessToken: "AIRTABLE_ACCESS_TOKEN",
          refreshToken: "AIRTABLE_REFRESH_TOKEN",
          envBindings: {
            AIRTABLE_TOKEN: "$secrets.AIRTABLE_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
