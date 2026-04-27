import type { ConnectorConfig } from "../connectors";

export const helicone = {
  helicone: {
    label: "Helicone",
    category: "ai-memory-tracing-eval",
    helpText:
      "Connect to Helicone for LLM cost tracking, request logging, and performance analytics.",
    environmentMapping: {
      HELICONE_TOKEN: "$secrets.HELICONE_TOKEN",
    },
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText: "Go to helicone.ai → Settings → API Keys → create a new key.",
        secrets: {
          HELICONE_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "sk-helicone-...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
