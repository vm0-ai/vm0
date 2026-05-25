import type { ConnectorConfig } from "../connectors";

export const langsmith = {
  langsmith: {
    label: "LangSmith",
    category: "ai-memory-tracing-eval",
    helpText:
      "Connect to LangSmith for LLM tracing, evaluation, and dataset management.",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "Go to [smith.langchain.com](https://smith.langchain.com) → Settings → API Keys → Create API Key.",
        grant: {
          kind: "manual",
          fields: {
            LANGSMITH_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "lsv2_pt_...",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            LANGSMITH_TOKEN: "$secrets.LANGSMITH_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
