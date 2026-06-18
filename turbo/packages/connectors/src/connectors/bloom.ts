import type { ConnectorConfig } from "../connectors";

export const bloom = {
  bloom: {
    label: "Bloom",
    category: "marketing-content-growth",
    helpText:
      "Connect your Bloom account to access brand generation APIs and MCP workflows",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your Bloom account\n2. Follow the [Bloom API docs](https://www.trybloom.ai/docs/api) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["BLOOM_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            BLOOM_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-bloom-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            BLOOM_API_KEY: "$secrets.BLOOM_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
