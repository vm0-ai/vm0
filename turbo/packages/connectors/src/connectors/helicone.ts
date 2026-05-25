import type { ConnectorConfig } from "../connectors";

export const helicone = {
  helicone: {
    label: "Helicone",
    category: "ai-memory-tracing-eval",
    helpText:
      "Connect to Helicone for LLM cost tracking, request logging, and performance analytics.",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText: "Go to helicone.ai → Settings → API Keys → create a new key.",
        grant: {
          kind: "manual",
          fields: {
            HELICONE_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "sk-helicone-...",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            HELICONE_TOKEN: "$secrets.HELICONE_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
