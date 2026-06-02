import type { ConnectorConfig } from "../connectors";

export const pinecone = {
  pinecone: {
    label: "Pinecone",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Pinecone account for vector database operations, semantic search, and managing embeddings",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Pinecone](https://app.pinecone.io)\n2. Go to **API Keys** in the left sidebar\n3. Copy your default API key or create a new one",
        storage: {
          secrets: ["PINECONE_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            PINECONE_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "pcsk_...",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            PINECONE_TOKEN: "$secrets.PINECONE_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
