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
        storage: {
          secrets: ["AIRTABLE_ACCESS_TOKEN", "AIRTABLE_REFRESH_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "auth-code",
          scopes: [
            "data.records:read",
            "data.records:write",
            "data.recordComments:read",
            "data.recordComments:write",
            "schema.bases:read",
            "schema.bases:write",
            "user.email:read",
          ],
          outputs: {
            accessToken: "$secrets.AIRTABLE_ACCESS_TOKEN",
            refreshToken: "$secrets.AIRTABLE_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.AIRTABLE_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.AIRTABLE_ACCESS_TOKEN",
            refreshToken: "$secrets.AIRTABLE_REFRESH_TOKEN",
          },
          refreshableSecrets: ["AIRTABLE_ACCESS_TOKEN"],
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
