import type { ConnectorConfig } from "../connectors";

export const mem0 = {
  mem0: {
    label: "Mem0",
    category: "ai-memory-tracing-eval",
    helpText:
      "Connect to Mem0 for persistent AI memory across conversations and sessions.",
    environmentMapping: { MEM0_TOKEN: "$secrets.MEM0_TOKEN" },
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "Go to [app.mem0.ai](https://app.mem0.ai) → **API Keys** → create or copy your key.",
        secrets: {
          MEM0_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "m0-...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
