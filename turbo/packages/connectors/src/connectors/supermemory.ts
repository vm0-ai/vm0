import type { ConnectorConfig } from "../connectors";

export const supermemory = {
  supermemory: {
    label: "Supermemory",
    category: "ai-memory-tracing-eval",
    helpText:
      "Connect to Supermemory for AI agent memory, semantic recall, and managed RAG.",
    environmentMapping: { SUPERMEMORY_API_KEY: "$secrets.SUPERMEMORY_API_KEY" },
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "Go to [console.supermemory.ai](https://console.supermemory.ai) → **API Keys** → create or copy your key.",
        secrets: {
          SUPERMEMORY_API_KEY: {
            label: "API Key",
            required: true,
            placeholder: "sm_...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
