import type { ConnectorConfig } from "../connectors";

export const db9 = {
  db9: {
    label: "db9",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your db9 account to manage serverless Postgres databases with pgvector, FTS, and embeddings",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [db9](https://db9.ai)\n2. Go to **Settings > API Keys**\n3. Create a new API key\n4. Copy the 128-character hex token",
        grant: {
          kind: "manual",
          fields: {
            DB9_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "128-char hex token",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            DB9_API_KEY: "$secrets.DB9_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
