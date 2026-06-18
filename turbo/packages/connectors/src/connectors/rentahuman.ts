import type { ConnectorConfig } from "../connectors";

export const rentahuman = {
  rentahuman: {
    label: "RentAHuman",
    category: "ai-agent-apps",
    helpText:
      "Connect your RentAHuman account to access human-task APIs and MCP workflows for agents",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your RentAHuman account\n2. Follow the [RentAHuman API docs](https://rentahuman.ai/docs) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["RENTAHUMAN_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            RENTAHUMAN_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-rentahuman-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            RENTAHUMAN_API_KEY: "$secrets.RENTAHUMAN_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
