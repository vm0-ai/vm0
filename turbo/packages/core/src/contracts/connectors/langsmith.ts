import type { ConnectorConfig } from "../connectors";

export const langsmith = {
  langsmith: {
    label: "LangSmith",
    helpText:
      "Connect to LangSmith for LLM tracing, evaluation, and dataset management.",
    environmentMapping: {
      LANGSMITH_TOKEN: "$secrets.LANGSMITH_TOKEN",
    },
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "Go to [smith.langchain.com](https://smith.langchain.com) → Settings → API Keys → Create API Key.",
        secrets: {
          LANGSMITH_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "lsv2_pt_...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
