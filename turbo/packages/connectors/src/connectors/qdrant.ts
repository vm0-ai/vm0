import type { ConnectorConfig } from "../connectors";

export const qdrant = {
  qdrant: {
    label: "Qdrant",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Qdrant account to store, search, and manage vector embeddings",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Qdrant Cloud](https://cloud.qdrant.io)\n2. Open your cluster's detail page and go to **API Keys**\n3. Click **Create** and configure your key\n4. Copy the key (shown only once)",
        storage: {
          secrets: ["QDRANT_TOKEN"],
          variables: ["QDRANT_BASE_URL"],
        },
        grant: {
          kind: "manual",
          fields: {
            QDRANT_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "your-qdrant-api-key",
            },
            QDRANT_BASE_URL: {
              label: "Cluster URL",
              required: true,
              placeholder: "https://your-cluster.region.cloud.qdrant.io:6333",
              storage: "variable",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            QDRANT_TOKEN: "$secrets.QDRANT_TOKEN",
            QDRANT_BASE_URL: "$vars.QDRANT_BASE_URL",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
